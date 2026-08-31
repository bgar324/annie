import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  RefreshBusyError,
  RefreshCoordinator,
  RefreshRequiredError,
} from "../src/connections/refresh.js";
import { ConnectionRecoveryService } from "../src/connections/recovery.js";
import { ConnectionRouter } from "../src/connections/router.js";
import { ConnectionStore } from "../src/connections/store.js";
import {
  ConnectionRoutingError,
  OAuthIdentityMismatchError,
} from "../src/connections/types.js";
import { newTraceId } from "../src/core/ids.js";
import { MessageEgressService } from "../src/messages/egress.js";
import type { DeliveryResource, MessageSender } from "../src/messages/types.js";
import { notionCapabilities } from "../src/oauth/notion.js";
import { OAuthAttemptStore } from "../src/oauth/attempts.js";
import { ConnectLinkError, ConnectLinkService } from "../src/oauth/links.js";
import { createGoogleOAuthClient, googleCapabilities } from "../src/oauth/google.js";
import type { ProviderFetch } from "../src/providers/fetch.js";
import { QueueStore } from "../src/queue/store.js";
import { CredentialVault } from "../src/security/vault.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { WriteStore } from "../src/writes/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe("multi-account connection store", () => {
  it("encrypts credentials, isolates identities, and routes only healthy capabilities", () => {
    const harness = connectionHarness();
    const firstTrace = newTraceId();
    const first = harness.connections.saveAuthorization({
      traceId: firstTrace,
      provider: "google",
      providerAccountId: "sub_account_a",
      safeLabel: "Work",
      safeMetadata: { email: "a@example.test" },
      providerState: { scopes: ["gmail.readonly"] },
      capabilities: ["gmail.search", "gmail.read_thread"],
      credentials: { refreshToken: "refresh-account-a" },
    });
    const second = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "sub_account_b",
      safeLabel: "Work",
      safeMetadata: { email: "b@example.test" },
      providerState: { scopes: ["gmail.readonly"] },
      capabilities: ["gmail.search", "gmail.read_thread"],
      credentials: { refreshToken: "refresh-account-b" },
    });

    expect(first.safeLabel).toBe("Work");
    expect(second.safeLabel).toBe("Work (2)");
    expect(harness.connections.loadCredentials(first.id)).toEqual({
      refreshToken: "refresh-account-a",
    });
    expect(harness.connections.loadCredentials(second.id)).toEqual({
      refreshToken: "refresh-account-b",
    });
    const encrypted = harness.database.handle.db
      .prepare<[], { ciphertext: Buffer }>("SELECT ciphertext FROM connection_secrets")
      .all();
    expect(encrypted.every((row) => !row.ciphertext.includes(Buffer.from("refresh-account")))).toBe(true);

    expect(() => harness.router.select({ capability: "gmail.search" })).toThrow(
      ConnectionRoutingError,
    );
    expect(
      harness.router.select({ capability: "gmail.search", account: "work (2)" }).id,
    ).toBe(second.id);

    expect(
      harness.connections.markReconnectRequired({
        connectionId: first.id,
        credentialGeneration: first.credentialGeneration,
        traceId: newTraceId(),
        errorCode: "invalid_grant",
        errorSummary: "Google rejected the refresh token",
      }),
    ).toBe(true);
    expect(harness.router.select({ capability: "gmail.search" }).id).toBe(second.id);
    expect(() =>
      harness.router.select({ capability: "gmail.search", account: "Work" }),
    ).toThrow(/requires reconnection/);
  });

  it("rejects account switching and ignores stale health updates after reauthorization", () => {
    const harness = connectionHarness();
    const original = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "sub_original",
      safeLabel: "Personal",
      safeMetadata: {},
      providerState: {},
      capabilities: ["gmail.search"],
      credentials: { refreshToken: "old-refresh" },
    });
    expect(() =>
      harness.connections.saveAuthorization({
        traceId: newTraceId(),
        provider: "google",
        providerAccountId: "sub_wrong",
        safeLabel: "Personal",
        safeMetadata: {},
        providerState: {},
        capabilities: ["gmail.search"],
        credentials: { refreshToken: "wrong-refresh" },
        expectedConnectionId: original.id,
      }),
    ).toThrow(OAuthIdentityMismatchError);

    const reauthorized = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "sub_original",
      safeLabel: "Personal",
      safeMetadata: {},
      providerState: {},
      capabilities: ["gmail.search"],
      credentials: { refreshToken: "new-refresh" },
      expectedConnectionId: original.id,
    });
    expect(reauthorized.credentialGeneration).toBe(2);
    expect(
      harness.connections.markDegraded({
        connectionId: original.id,
        credentialGeneration: original.credentialGeneration,
        traceId: newTraceId(),
        retryAtMs: Date.now() + 10_000,
        errorCode: "stale_refresh",
        errorSummary: "A stale refresh failed",
      }),
    ).toBe(false);
    expect(harness.connections.getRequired(original.id).status).toBe("healthy");
  });
});

describe("connection links and OAuth attempts", () => {
  it("survives preview GETs, reuses the attempt, then consumes exactly once at callback", () => {
    const harness = connectionHarness();
    const link = harness.links.issue({
      provider: "google",
      purpose: "connect",
      traceId: newTraceId(),
    });
    const token = new URL(link.url).searchParams.get("token");
    expect(token).not.toBeNull();
    const preview = harness.links.resolve(token!, "google");
    expect(harness.links.resolve(token!, "google").id).toBe(preview.id);

    const first = harness.attempts.createOrReuse({
      link: preview,
      build: ({ state, codeChallenge }) => ({
        authorizationUrl: `https://accounts.example/authorize?state=${state}&challenge=${codeChallenge}`,
        context: { marker: "durable" },
      }),
    });
    const second = harness.attempts.createOrReuse({
      link: preview,
      build: () => {
        throw new Error("A preview reload must reuse the durable attempt");
      },
    });
    expect(second.id).toBe(first.id);
    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    const state = new URL(first.authorizationUrl).searchParams.get("state");
    expect(state).not.toBeNull();

    const callback = harness.attempts.beginExchange({ provider: "google", state: state! });
    const duplicateCallback = harness.attempts.beginExchange({ provider: "google", state: state! });
    expect(callback.fresh).toBe(true);
    expect(duplicateCallback.fresh).toBe(false);
    expect(duplicateCallback.attempt.status).toBe("exchange_started");
    expect(() => harness.links.resolve(token!, "google")).toThrow(ConnectLinkError);
  });

  it("rejects expired, wrong-provider, and tampered bearer links", () => {
    const harness = connectionHarness(1_000);
    const link = harness.links.issue({
      provider: "notion",
      purpose: "connect",
      traceId: newTraceId(),
      nowMs: 1_000,
    });
    const token = new URL(link.url).searchParams.get("token")!;
    expect(() => harness.links.resolve(token, "google", 1_500)).toThrow(/another provider/);
    expect(() => harness.links.resolve(token, "notion", 2_000)).toThrow(/expired/);
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`;
    expect(() => harness.links.resolve(tamperedToken, "notion", 1_500)).toThrow(/invalid/);
  });
});

describe("provider capability truth", () => {
  it("intersects every exact Notion tool name with current access", () => {
    const access = {
      search: { status: "available" as const },
      fetch: { status: "available_with_limit" as const },
      create_pages: { status: "upgrade_required" as const },
      update_page: { status: "available" as const },
    };
    const advertised = new Set([
      "notion-search",
      "notion-fetch",
      "notion-create-pages",
      // notion-update-page is deliberately absent from the complete advertised set.
    ]);
    expect(notionCapabilities(access, advertised)).toEqual(["notion.search", "notion.fetch"]);
  });

  it("derives Gmail capabilities from actual grants rather than requested scopes", () => {
    expect(
      googleCapabilities(["openid", "https://www.googleapis.com/auth/gmail.readonly"]),
    ).toEqual(["gmail.search", "gmail.read_thread"]);
    expect(googleCapabilities(["https://www.googleapis.com/auth/gmail.compose"])).toEqual([
      "gmail.create_draft",
      "gmail.send_draft",
    ]);
  });
});

describe("automatic credential refresh and recovery", () => {
  it("retries explicit Notion 503 responses, then atomically stores rotated credentials", async () => {
    const harness = connectionHarness();
    const config = testRuntimeConfig(harness.database);
    const now = Date.now();
    const connection = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "notion",
      providerAccountId: "workspace_refresh",
      safeLabel: "Product",
      safeMetadata: { workspaceName: "Product" },
      providerState: {
        tokenEndpoint: "https://mcp.notion.test/token",
        scopes: [],
        currentToolAccess: {},
      },
      capabilities: ["notion.fetch"],
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenType: "Bearer",
        expiresAtMs: now - 1,
        scopes: [],
        userId: "user_1",
        workspaceId: "workspace_refresh",
      },
      expiresAtMs: now - 1,
    });
    let requests = 0;
    const waits: number[] = [];
    const fetchImpl: ProviderFetch = async () => {
      requests += 1;
      if (requests < 3) {
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const refresh = new RefreshCoordinator({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      traces: harness.traces,
      fetchImpl,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    const credentials = await refresh.credentials<{
      accessToken: string;
      refreshToken: string;
    }>(connection.id, newTraceId(), now);
    const updated = harness.connections.getRequired(connection.id);

    expect(requests).toBe(3);
    expect(waits).toEqual([250, 500]);
    expect(credentials).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(updated.credentialGeneration).toBe(2);
    expect(updated.status).toBe("healthy");
    expect(
      harness.database.handle.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM refresh_leases")
        .get()?.count,
    ).toBe(0);
  });

  it("keeps a dispatched refresh fenced past the former lease boundary", async () => {
    const harness = connectionHarness();
    const config = testRuntimeConfig(harness.database, {
      PROVIDER_REQUEST_TIMEOUT_MS: "100",
    });
    const now = Date.now();
    const connection = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "sub_concurrent",
      safeLabel: "Concurrent",
      safeMetadata: {},
      providerState: {
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
      capabilities: ["gmail.search", "gmail.read_thread"],
      credentials: {
        refreshToken: "refresh-concurrent",
        expiryDateMs: now - 1,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
      expiresAtMs: now - 1,
    });
    const requestStarted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    let requests = 0;
    const refresh = new RefreshCoordinator({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        requestStarted.resolve();
        await releaseResponse.promise;
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      sleep: async () => undefined,
    });

    const firstRefresh = refresh.credentials(connection.id, newTraceId(), now);
    await requestStarted.promise;
    await expect(
      refresh.credentials(
        connection.id,
        newTraceId(),
        now + config.limits.providerRequestTimeoutMs * 2 + 1,
      ),
    ).rejects.toBeInstanceOf(RefreshBusyError);
    expect(requests).toBe(1);

    releaseResponse.resolve();
    await expect(firstRefresh).resolves.toMatchObject({ accessToken: "new-access" });
    expect(requests).toBe(1);
    expect(harness.connections.getRequired(connection.id).status).toBe("healthy");
  });

  it("does not retry an ambiguous rotating-token response and deduplicates the recovery link", async () => {
    const harness = connectionHarness();
    const config = testRuntimeConfig(harness.database);
    const now = Date.now();
    const connection = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "notion",
      providerAccountId: "workspace_ambiguous",
      safeLabel: "Operations",
      safeMetadata: {},
      providerState: { tokenEndpoint: "https://mcp.notion.test/token" },
      capabilities: ["notion.fetch"],
      credentials: {
        accessToken: "expired-access",
        refreshToken: "rotating-refresh-secret",
        tokenType: "Bearer",
        expiresAtMs: now - 1,
        scopes: [],
        userId: "user_2",
        workspaceId: "workspace_ambiguous",
      },
      expiresAtMs: now - 1,
    });
    const queue = new QueueStore({
      db: harness.database.handle.db,
      traces: harness.traces,
      leaseMs: 1_000,
      maxPending: 32,
    });
    const writes = new WriteStore(harness.database.handle.db, harness.traces);
    const gateway: MessageSender = {
      async send(): Promise<DeliveryResource> {
        throw new Error("The recovery job must remain queued in this test");
      },
      async getStatus(): Promise<DeliveryResource> {
        throw new Error("No delivery status read expected");
      },
    };
    const egress = new MessageEgressService({
      db: harness.database.handle.db,
      gateway,
      queue,
      traces: harness.traces,
      writes,
      lineNumber: config.sendblue.fromNumber,
    });
    const recovery = new ConnectionRecoveryService({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      links: harness.links,
      egress,
      queue,
    });
    let requests = 0;
    const traceId = newTraceId();
    const refresh = new RefreshCoordinator({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      traces: harness.traces,
      recovery,
      fetchImpl: async () => {
        requests += 1;
        throw new TypeError("socket closed after request dispatch");
      },
      sleep: async () => undefined,
    });

    await expect(refresh.credentials(connection.id, traceId, now)).rejects.toBeInstanceOf(
      RefreshRequiredError,
    );
    const unhealthy = harness.connections.getRequired(connection.id);
    const firstEgress = recovery.planReconnect(connection.id, traceId);
    const secondEgress = recovery.planReconnect(connection.id, traceId);
    const counts = harness.database.handle.db
      .prepare<[], { notices: number; jobs: number }>(`
        SELECT
          (SELECT COUNT(*) FROM recovery_notices) AS notices,
          (SELECT COUNT(*) FROM jobs WHERE type = 'egress_send') AS jobs
      `)
      .get();

    expect(requests).toBe(1);
    expect(unhealthy.status).toBe("reconnect_required");
    expect(firstEgress).toBe(secondEgress);
    expect(counts).toEqual({ notices: 1, jobs: 1 });
    expect(JSON.stringify(harness.traces.list(traceId))).not.toContain("rotating-refresh-secret");
  });
});

describe("Google OAuth transport", () => {
  it("makes exactly one token request when the transport receives HTTP 503", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporarily_unavailable" }));
    });
    const started = Promise.withResolvers<void>();
    server.once("error", started.reject);
    server.listen(0, "127.0.0.1", started.resolve);
    await started.promise;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP test server address");
      }
      const database = createTestDatabase();
      databases.push(database);
      const config = testRuntimeConfig(database);
      const client = createGoogleOAuthClient(config, {
        oauth2TokenUrl: `http://127.0.0.1:${address.port}/token`,
      });
      await expect(client.getToken({ code: "one-use-code", codeVerifier: "verifier" })).rejects.toThrow();
      expect(requests).toBe(1);
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error === undefined ? closed.resolve() : closed.reject(error)));
      await closed.promise;
    }
  });
});

function connectionHarness(ttlMs = 600_000) {
  const database = createTestDatabase();
  databases.push(database);
  const vault = new CredentialVault(Buffer.alloc(32, 11));
  const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
  const connections = new ConnectionStore(database.handle.db, vault, traces);
  const links = new ConnectLinkService({
    db: database.handle.db,
    signingKey: vault.linkSigningKey(),
    publicBaseUrl: "https://assistant.example",
    traces,
    ttlMs,
  });
  const attempts = new OAuthAttemptStore({ db: database.handle.db, links, vault, traces });
  return {
    database,
    vault,
    traces,
    connections,
    router: new ConnectionRouter(connections),
    links,
    attempts,
  };
}

function testRuntimeConfig(
  database: TestDatabase,
  overrides: Record<string, string> = {},
): RuntimeConfig {
  return loadRuntimeConfig({
    NODE_ENV: "test",
    DATA_DIR: database.directory,
    DATABASE_PATH: database.config.databasePath,
    MEMORY_PATH: database.config.memoryPath,
    TRACE_DIR: database.config.traceDir,
    SENDBLUE_API_KEY_ID: "sendblue_test_key_id",
    SENDBLUE_API_SECRET_KEY: "sendblue_test_secret_key",
    SENDBLUE_FROM_NUMBER: "+15551112222",
    SENDBLUE_BASE_URL: "https://api.sendblue.co",
    USER_PHONE_NUMBER: "+15559990000",
    PUBLIC_BASE_URL: "https://assistant.example",
    GEMINI_API_KEY: "gemini_test_key",
    GOOGLE_CLIENT_ID: "google_test_client",
    GOOGLE_CLIENT_SECRET: "google_test_secret",
    GOOGLE_WORKSPACE_SCOPES: "openid email https://www.googleapis.com/auth/gmail.readonly",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  });
}
