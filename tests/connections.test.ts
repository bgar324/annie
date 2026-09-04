import { createServer } from "node:http";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_READ_SCOPES,
  loadRuntimeConfig,
  type RuntimeConfig,
} from "../src/config.js";
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
  GOOGLE_CONNECTION_CAPABILITIES,
  OAuthIdentityMismatchError,
} from "../src/connections/types.js";
import { newTraceId } from "../src/core/ids.js";
import { MessageEgressService } from "../src/messages/egress.js";
import type { DeliveryResource, MessageSender } from "../src/messages/types.js";
import { parseNotionSelf } from "../src/notion/bootstrap.js";
import { notionCapabilities } from "../src/oauth/notion.js";
import { OAuthAttemptStore } from "../src/oauth/attempts.js";
import { ConnectLinkError, ConnectLinkService } from "../src/oauth/links.js";
import {
  createGoogleOAuthClient,
  googleCapabilities,
  googleScopeBundleStatus,
  registerGoogleOAuth,
} from "../src/oauth/google.js";
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
      capabilities: ["gmail.read"],
      credentials: { refreshToken: "refresh-account-a" },
    });
    const second = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "sub_account_b",
      safeLabel: "Work",
      safeMetadata: { email: "b@example.test" },
      providerState: { scopes: ["gmail.readonly"] },
      capabilities: ["gmail.read"],
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

    expect(() => harness.router.select({ capabilities: ["gmail.read"] })).toThrow(
      "Multiple healthy google connections grant gmail.read. This tool call requires one exact safe label: Work, Work (2)",
    );
    expect(
      harness.router.select({ capabilities: ["gmail.read"], account: "work (2)" }).id,
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
    expect(harness.router.select({ capabilities: ["gmail.read"] }).id).toBe(second.id);
    expect(() =>
      harness.router.select({ capabilities: ["gmail.read"], account: "Work" }),
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
      capabilities: ["gmail.read"],
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
        capabilities: ["gmail.read"],
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
      capabilities: ["gmail.read"],
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
    const signatureStart = token.indexOf(".") + 1;
    const tamperedToken = `${token.slice(0, signatureStart)}${
      token[signatureStart] === "A" ? "B" : "A"
    }${token.slice(signatureStart + 1)}`;
    expect(() => harness.links.resolve(tamperedToken, "notion", 1_500)).toThrow(/invalid/);
  });

  it("fails incomplete saved grants and activates the complete Workspace bundle", async () => {
    const harness = connectionHarness();
    const config = testRuntimeConfig(harness.database);
    const app = Fastify({ logger: false });
    registerGoogleOAuth({
      app,
      config,
      links: harness.links,
      attempts: harness.attempts,
      connections: harness.connections,
      traces: harness.traces,
    });

    const saveGrant = (input: {
      suffix: string;
      scopes: readonly string[];
    }): { attemptId: ReturnType<typeof harness.attempts.createOrReuse>["id"]; state: string } => {
      const link = harness.links.issue({
        provider: "google",
        purpose: "connect",
        traceId: newTraceId(),
      });
      const token = new URL(link.url).searchParams.get("token");
      if (token === null) {
        throw new Error("Expected the connection link to contain a token");
      }
      const binding = harness.links.resolve(token, "google");
      let state = "";
      const attempt = harness.attempts.createOrReuse({
        link: binding,
        build: (security) => {
          state = security.state;
          return {
            authorizationUrl: `https://accounts.example/authorize?state=${security.state}`,
            context: {},
          };
        },
      });
      harness.attempts.beginExchange({ provider: "google", state });
      harness.attempts.saveExchangeResult({
        attemptId: attempt.id,
        providerIdentity: `sub_${input.suffix}`,
        context: {
          providerAccountId: `sub_${input.suffix}`,
          safeLabel: `Google ${input.suffix}`,
          safeMetadata: { email: `${input.suffix}@example.test`, emailVerified: true },
          providerState: { scopes: [...input.scopes] },
          credentials: {
            accessToken: `access-${input.suffix}`,
            refreshToken: `refresh-${input.suffix}`,
            scopes: [...input.scopes],
          },
        },
      });
      return { attemptId: attempt.id, state };
    };

    try {
      const incomplete = saveGrant({
        suffix: "incomplete",
        scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      });
      const rejected = await app.inject({
        method: "GET",
        url: `/oauth/google/callback?state=${encodeURIComponent(incomplete.state)}`,
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toContain("Google permissions are incomplete");
      expect(harness.attempts.getRequired(incomplete.attemptId)).toMatchObject({
        status: "failed",
        failureCode: "scope_bundle_incomplete",
      });
      expect(harness.connections.list("google")).toHaveLength(0);
      const missingIdentity = saveGrant({
        suffix: "missing_identity",
        scopes: GOOGLE_WORKSPACE_READ_SCOPES.filter((scope) => scope !== "email"),
      });
      const missingIdentityResponse = await app.inject({
        method: "GET",
        url: `/oauth/google/callback?state=${encodeURIComponent(missingIdentity.state)}`,
      });
      expect(missingIdentityResponse.statusCode).toBe(400);
      expect(harness.attempts.getRequired(missingIdentity.attemptId)).toMatchObject({
        status: "failed",
        failureCode: "scope_bundle_incomplete",
      });

      const extraScope = saveGrant({
        suffix: "extra_scope",
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES, "profile"],
      });
      const extraScopeResponse = await app.inject({
        method: "GET",
        url: `/oauth/google/callback?state=${encodeURIComponent(extraScope.state)}`,
      });
      expect(extraScopeResponse.statusCode).toBe(400);
      expect(harness.attempts.getRequired(extraScope.attemptId)).toMatchObject({
        status: "failed",
        failureCode: "scope_not_read_only",
      });
      expect(harness.connections.list("google")).toHaveLength(0);


      const complete = saveGrant({
        suffix: "complete",
        scopes: GOOGLE_WORKSPACE_READ_SCOPES,
      });
      const accepted = await app.inject({
        method: "GET",
        url: `/oauth/google/callback?state=${encodeURIComponent(complete.state)}`,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.body).toContain("Google is connected");
      expect(harness.attempts.getRequired(complete.attemptId).status).toBe("active");
      const connected = harness.connections.list("google");
      expect(connected).toHaveLength(1);
      expect(connected[0]).toMatchObject({
        providerAccountId: "sub_complete",
        status: "healthy",
      });
      expect(connected[0]?.capabilities).toHaveLength(GOOGLE_CONNECTION_CAPABILITIES.length);
      expect(connected[0]?.capabilities).toEqual(
        expect.arrayContaining([...GOOGLE_CONNECTION_CAPABILITIES]),
      );
    } finally {
      await app.close();
    }
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

  it("ignores unrelated Notion access statuses when deriving exact capabilities", () => {
    const self = parseNotionSelf({
      self: {
        workspace: { id: "workspace_1", name: "Test workspace" },
        user: { id: "user_1", name: "Test user", type: "person" },
        current_tool_access: {
          search: { status: "available" },
          future_tool: { status: "provider_defined" },
        },
      },
    });

    expect(notionCapabilities(self.current_tool_access, new Set(["notion-search"]))).toEqual([
      "notion.search",
    ]);
  });

  it("derives semantic Google capabilities from exact read-only grants", () => {
    expect(
      googleCapabilities(["openid", "https://www.googleapis.com/auth/gmail.readonly"]),
    ).toEqual(["gmail.read"]);
    expect(
      googleCapabilities([
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      ]),
    ).toEqual([]);
    expect(
      googleCapabilities([
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/tasks.readonly",
      ]),
    ).toEqual(["calendar.read", "drive.read", "contacts.read", "tasks.read"]);
    expect(googleCapabilities(["https://www.googleapis.com/auth/gmail.modify"])).toEqual([]);
    expect(googleScopeBundleStatus(GOOGLE_WORKSPACE_READ_SCOPES)).toBe("complete");
    expect(
      googleScopeBundleStatus(["https://www.googleapis.com/auth/gmail.readonly"]),
    ).toBe("incomplete");
    expect(
      googleScopeBundleStatus(["https://www.googleapis.com/auth/gmail.modify"]),
    ).toBe("unsafe");
    const broaderCalendarGrant: string[] = [
      ...GOOGLE_WORKSPACE_READ_SCOPES.filter(
        (scope) =>
          scope !== "https://www.googleapis.com/auth/calendar.calendarlist.readonly" &&
          scope !== "https://www.googleapis.com/auth/calendar.events.readonly",
      ),
      "https://www.googleapis.com/auth/calendar.readonly",
    ];
    expect(googleScopeBundleStatus(broaderCalendarGrant)).toBe("unsafe");
    expect(
      googleScopeBundleStatus([...GOOGLE_WORKSPACE_READ_SCOPES, "profile"]),
    ).toBe("unsafe");
    expect(
      googleScopeBundleStatus([
        ...GOOGLE_WORKSPACE_READ_SCOPES,
        "https://www.googleapis.com/auth/userinfo.email",
      ]),
    ).toBe("complete");
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

  it("clears a dispatched refresh lease when cancellation follows a confirmed retryable response", async () => {
    const harness = connectionHarness();
    const config = testRuntimeConfig(harness.database);
    const now = Date.now();
    const connection = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "sub_cancelled_refresh",
      safeLabel: "Cancelled refresh",
      safeMetadata: {},
      providerState: { scopes: [...GOOGLE_WORKSPACE_READ_SCOPES] },
      capabilities: [...GOOGLE_CONNECTION_CAPABILITIES],
      credentials: {
        accessToken: "expired-access",
        refreshToken: "refresh-cancelled",
        expiryDateMs: now - 1,
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES],
      },
      expiresAtMs: now - 1,
    });
    const controller = new AbortController();
    let requests = 0;
    const refresh = new RefreshCoordinator({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        controller.abort(new Error("run deadline"));
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
      sleep: async () => undefined,
    });

    await expect(
      refresh.credentials(connection.id, newTraceId(), now, controller.signal),
    ).rejects.toThrow("run deadline");
    expect(requests).toBe(1);
    expect(
      harness.database.handle.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM refresh_leases")
        .get()?.count,
    ).toBe(0);
    expect(harness.connections.getRequired(connection.id).status).toBe("healthy");
  });

  it("single-flights refreshes per process while preserving cross-process fencing", async () => {
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
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES],
      },
      capabilities: [...GOOGLE_CONNECTION_CAPABILITIES],
      credentials: {
        refreshToken: "refresh-concurrent",
        expiryDateMs: now - 1,
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES],
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
    const secondRefresh = refresh.credentials(
      connection.id,
      newTraceId(),
      now + config.limits.providerRequestTimeoutMs * 2 + 1,
    );
    const otherProcess = new RefreshCoordinator({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      traces: harness.traces,
      fetchImpl: async () => {
        throw new Error("A fenced refresh must not dispatch");
      },
      sleep: async () => undefined,
    });
    await expect(
      otherProcess.credentials(connection.id, newTraceId(), now),
    ).rejects.toBeInstanceOf(RefreshBusyError);
    expect(requests).toBe(1);

    releaseResponse.resolve();
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      expect.objectContaining({ accessToken: "new-access" }),
      expect.objectContaining({ accessToken: "new-access" }),
    ]);
    expect(requests).toBe(1);
    expect(harness.connections.getRequired(connection.id).status).toBe("healthy");
  });

  it.each([
    {
      suffix: "missing_identity",
      refreshedScopes: GOOGLE_WORKSPACE_READ_SCOPES.filter((scope) => scope !== "email"),
    },
    {
      suffix: "extra_scope",
      refreshedScopes: [...GOOGLE_WORKSPACE_READ_SCOPES, "profile"],
    },
    {
      suffix: "write_scope",
      refreshedScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
    },
  ])("rejects a refreshed Google token with an exact-grant mismatch: $suffix", async ({
    suffix,
    refreshedScopes,
  }) => {
    const harness = connectionHarness();
    const config = testRuntimeConfig(harness.database);
    const now = Date.now();
    const connection = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: `sub_scope_change_${suffix}`,
      safeLabel: `Scope change ${suffix}`,
      safeMetadata: {},
      providerState: {
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES],
      },
      capabilities: [...GOOGLE_CONNECTION_CAPABILITIES],
      credentials: {
        accessToken: "old-access",
        refreshToken: `refresh-scope-change-${suffix}`,
        expiryDateMs: now - 1,
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES],
      },
      expiresAtMs: now - 1,
    });
    const refresh = new RefreshCoordinator({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      traces: harness.traces,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: "unsafe-access",
            expires_in: 3_600,
            scope: refreshedScopes.join(" "),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      sleep: async () => undefined,
    });

    await expect(refresh.credentials(connection.id, newTraceId(), now)).rejects.toBeInstanceOf(
      RefreshRequiredError,
    );
    expect(harness.connections.getRequired(connection.id)).toMatchObject({
      status: "reconnect_required",
      lastErrorCode: "google_scope_bundle_changed",
      credentialGeneration: connection.credentialGeneration,
    });
    expect(harness.connections.loadCredentials(connection.id)).toMatchObject({
      accessToken: "old-access",
    });
  });

  it("never retries a Google refresh after its response is lost", async () => {
    const harness = connectionHarness();
    const config = testRuntimeConfig(harness.database);
    const now = Date.now();
    const connection = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "sub_lost_refresh",
      safeLabel: "Lost refresh",
      safeMetadata: {},
      providerState: {
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES],
      },
      capabilities: [...GOOGLE_CONNECTION_CAPABILITIES],
      credentials: {
        accessToken: "expired-access",
        refreshToken: "rotating-google-refresh",
        expiryDateMs: now - 1,
        scopes: [...GOOGLE_WORKSPACE_READ_SCOPES],
      },
      expiresAtMs: now - 1,
    });
    let requests = 0;
    const refresh = new RefreshCoordinator({
      db: harness.database.handle.db,
      config,
      connections: harness.connections,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        throw new Error("The accepted refresh response was lost");
      },
      sleep: async () => undefined,
    });

    await expect(refresh.credentials(connection.id, newTraceId(), now)).rejects.toBeInstanceOf(
      RefreshRequiredError,
    );
    expect(requests).toBe(1);
    expect(harness.connections.getRequired(connection.id)).toMatchObject({
      status: "reconnect_required",
      lastErrorCode: "refresh_response_lost",
    });
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
    DEEPSEEK_API_KEY: "deepseek_test_key",
    GOOGLE_CLIENT_ID: "google_test_client",
    GOOGLE_CLIENT_SECRET: "google_test_secret",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  });
}
