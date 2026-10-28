import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.js";
import { RefreshCoordinator, RefreshRequiredError, suppressRecoveryNotifications } from "../src/connections/refresh.js";
import { ConnectionRecoveryService } from "../src/connections/recovery.js";
import { ConnectionStore } from "../src/connections/store.js";
import { newTraceId } from "../src/core/ids.js";
import { MessageEgressService } from "../src/messages/egress.js";
import { ConnectLinkService } from "../src/oauth/links.js";
import { QueueStore } from "../src/queue/store.js";
import { CredentialVault } from "../src/security/vault.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { WriteStore } from "../src/writes/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.cleanup(); });

function harness() {
  const database = createTestDatabase();
  databases.push(database);
  const db = database.handle.db;
  const config = loadRuntimeConfig({
    NODE_ENV: "test", DATA_DIR: database.directory, DATABASE_PATH: database.config.databasePath,
    MEMORY_PATH: database.config.memoryPath, TRACE_DIR: database.config.traceDir,
    SENDBLUE_API_KEY_ID: "synthetic-key", SENDBLUE_API_SECRET_KEY: "synthetic-secret",
    SENDBLUE_FROM_NUMBER: "+15551112222", USER_PHONE_NUMBER: "+15559990000",
    PUBLIC_BASE_URL: "https://assistant.example", DEEPSEEK_API_KEY: "synthetic-model-key",
    GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  const traces = new TraceStore(db, createTraceRedactor([]));
  const vault = new CredentialVault(config.credentialEncryptionKey);
  const connections = new ConnectionStore(db, vault, traces);
  const links = new ConnectLinkService({ db, signingKey: vault.linkSigningKey(), publicBaseUrl: config.publicBaseUrl, traces, ttlMs: 60_000 });
  const queue = new QueueStore({ db, traces, leaseMs: 1_000, maxPending: 32 });
  const writes = new WriteStore(db, traces);
  const egress = new MessageEgressService({
    db, queue, traces, writes, lineNumber: config.sendblue.fromNumber,
    gateway: {
      async send() { throw new Error("No provider writes in notification planning tests"); },
      async getStatus() { throw new Error("No provider status reads expected"); },
      async startTyping() { throw new Error("No provider typing writes expected"); },
    },
  });
  const recovery = new ConnectionRecoveryService({ db, config, connections, links, egress, queue });
  const connection = connections.saveAuthorization({
    traceId: newTraceId(), provider: "notion", providerAccountId: "synthetic-workspace",
    safeLabel: "Projects", safeMetadata: {}, providerState: { tokenEndpoint: "https://mcp.notion.test/token" },
    capabilities: ["notion.fetch"], expiresAtMs: Date.now() - 1,
    credentials: { accessToken: "synthetic-expired-access", refreshToken: "synthetic-refresh", tokenType: "Bearer", expiresAtMs: Date.now() - 1, scopes: [], userId: "synthetic-user", workspaceId: "synthetic-workspace" },
  });
  const dispatched = Promise.withResolvers<void>();
  const provider = Promise.withResolvers<Response>();
  let requests = 0;
  const refresh = new RefreshCoordinator({
    db, config, connections, traces, recovery,
    fetchImpl: async () => { requests++; dispatched.resolve(); return provider.promise; },
  });
  return {
    db, connection, connections, refresh, dispatched, provider,
    requests: () => requests,
    notices: () => db.prepare<[], { count: number }>("SELECT count(*) count FROM jobs WHERE type='egress_send'").get()?.count,
  };
}

const observeFailure = (operation: Promise<unknown>) => operation.catch((error: unknown) => error);

describe("web brief reconnect notification policy", () => {
  it.each(["web-first", "inbound-first"])("keeps notification ownership per caller during shared refresh: %s", async (order) => {
    const h = harness();
    const web = () => suppressRecoveryNotifications(() => h.refresh.credentials(h.connection.id, newTraceId()));
    const inbound = () => h.refresh.credentials(h.connection.id, newTraceId());
    const first = observeFailure(order === "web-first" ? web() : inbound());
    await h.dispatched.promise;
    const second = observeFailure(order === "web-first" ? inbound() : web());
    h.provider.reject(new TypeError("Synthetic response lost after dispatch"));
    const failures = await Promise.all([first, second]);
    expect(failures.every((failure) => failure instanceof RefreshRequiredError)).toBe(true);
    expect(h.requests()).toBe(1);
    expect(h.connections.getRequired(h.connection.id).status).toBe("reconnect_required");
    expect(h.notices()).toBe(1);
  });

  it("suppresses the web notice but allows a later inbound caller to plan recovery", async () => {
    const h = harness();
    const web = observeFailure(suppressRecoveryNotifications(() => h.refresh.credentials(h.connection.id, newTraceId())));
    await h.dispatched.promise;
    h.provider.reject(new TypeError("Synthetic response lost after dispatch"));
    expect(await web).toBeInstanceOf(RefreshRequiredError);
    expect(h.notices()).toBe(0);
    await expect(h.refresh.credentials(h.connection.id, newTraceId())).rejects.toBeInstanceOf(RefreshRequiredError);
    await expect(h.refresh.credentials(h.connection.id, newTraceId())).rejects.toBeInstanceOf(RefreshRequiredError);
    expect(h.requests()).toBe(1);
    expect(h.notices()).toBe(1);
  });
});
