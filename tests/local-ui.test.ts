import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalUiConfig, type LocalUiConfig } from "../src/config.js";
import { ConnectionStore } from "../src/connections/store.js";
import { newTraceId } from "../src/core/ids.js";
import { createLocalUiApp } from "../src/local-ui/server.js";
import { MemoryDocumentStore } from "../src/memory/document.js";
import { ConnectLinkService } from "../src/oauth/links.js";
import { CredentialVault } from "../src/security/vault.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";
import type { FastifyInstance } from "fastify";

const apps: FastifyInstance[] = [];
const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close().catch(() => undefined);
  }
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe("local UI configuration", () => {
  it("is opt-in and pins its listener to IPv4 loopback", () => {
    const expected = {
      host: "127.0.0.1",
      port: 3010,
      authority: "127.0.0.1:3010",
      origin: "http://127.0.0.1:3010",
    };
    expect(
      loadLocalUiConfig(
        { port: 3000 },
        {
          LOCAL_UI_ENABLED: "true",
          LOCAL_UI_PORT: "3010",
          LOCAL_UI_HOST: "0.0.0.0",
        },
      ),
    ).toEqual(expected);
    expect(
      loadLocalUiConfig(
        { port: 8080 },
        { LOCAL_UI_ENABLED: "true", LOCAL_UI_PORT: "3010" },
      ),
    ).toEqual(expected);
    expect(
      loadLocalUiConfig(
        { port: 8080 },
        { LOCAL_UI_ENABLED: "false", LOCAL_UI_PORT: "8080" },
      ),
    ).toBeUndefined();
    expect(() =>
      loadLocalUiConfig(
        { port: 3000 },
        { LOCAL_UI_ENABLED: "true", LOCAL_UI_PORT: "3000" },
      ),
    ).toThrow(/must differ from PORT/u);
  });
});

describe("loopback local UI", () => {
  it("renders only the safe account projection and escapes labels", async () => {
    const harness = await localUiHarness();
    const providerAccountSentinel = "provider-account-must-not-render";
    const metadataSentinel = "metadata-must-not-render";
    const stateSentinel = "provider-state-must-not-render";
    const credentialSentinel = "credential-must-not-render";
    const errorSentinel = "provider-error-must-not-render";
    const connection = harness.connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: providerAccountSentinel,
      safeLabel: "<Personal & Work>",
      safeMetadata: { privateValue: metadataSentinel },
      providerState: { privateValue: stateSentinel },
      capabilities: ["gmail.read", "calendar.read"],
      credentials: { refreshToken: credentialSentinel },
      expiresAtMs: 4_242_424_242_424,
    });
    harness.database.handle.db
      .prepare<{ id: string; code: string; summary: string }>(`
        UPDATE connections
        SET status = 'degraded', last_error_code = @code, last_error_summary = @summary
        WHERE id = @id
      `)
      .run({ id: connection.id, code: errorSentinel, summary: errorSentinel });

    const response = await harness.app.inject({
      method: "GET",
      url: "/",
      headers: { host: harness.config.authority },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("&lt;Personal &amp; Work&gt;");
    expect(response.body).toContain("Degraded");
    expect(response.body).toContain("Calendar · Gmail");
    expect(response.body).not.toContain("<Personal & Work>");
    for (const sentinel of [
      connection.id,
      providerAccountSentinel,
      metadataSentinel,
      stateSentinel,
      credentialSentinel,
      errorSentinel,
      "4242424242424",
    ]) {
      expect(response.body).not.toContain(sentinel);
    }
  });

  it("rejects rebinding and cross-origin mutations and emits hardened responses", async () => {
    const harness = await localUiHarness();
    const badHost = await harness.app.inject({
      method: "GET",
      url: "/",
      headers: { host: "localhost:3001", "x-forwarded-host": harness.config.authority },
    });
    expect(badHost.statusCode).toBe(421);

    const root = await getRoot(harness);
    const csrf = csrfFrom(root.body);
    const foreign = await postForm(harness, "/memory", {
      csrf,
      expectedRevision: (await harness.memory.loadSnapshot()).revision,
      content: "# Memory\n\n- Foreign request\n",
    }, "http://evil.example");
    const nullOrigin = await postForm(
      harness,
      "/connections/google",
      { csrf },
      "null",
    );
    const missingOrigin = await harness.app.inject({
      method: "POST",
      url: "/connections/google",
      headers: {
        host: harness.config.authority,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(foreign.statusCode).toBe(403);
    expect(nullOrigin.statusCode).toBe(403);
    expect(missingOrigin.statusCode).toBe(403);
    expect(root.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(root.headers["referrer-policy"]).toBe("same-origin");
    expect(root.headers["x-content-type-options"]).toBe("nosniff");
    expect(root.headers["x-frame-options"]).toBe("DENY");
    expect(root.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(root.headers["content-security-policy"]).toContain(
      "form-action 'self' http://127.0.0.1:3000 https://accounts.google.com",
    );
    expect(root.headers["access-control-allow-origin"]).toBeUndefined();
    expect(foreign.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("issues a traced Google link only as a server-side redirect", async () => {
    const harness = await localUiHarness();
    const csrf = csrfFrom((await getRoot(harness)).body);
    const response = await postForm(harness, "/connections/google", { csrf });

    expect(response.statusCode).toBe(303);
    const location = response.headers.location;
    expect(location).toMatch(/^http:\/\/127\.0\.0\.1:3000\/connect\/google\?token=/u);
    expect(response.body).not.toContain("token=");
    expect(
      harness.database.handle.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM oauth_link_tokens")
        .get()?.count,
    ).toBe(1);
    const token = new URL(location!).searchParams.get("token");
    const traceJson = harness.database.handle.db
      .prepare<[], { redacted_json: string }>("SELECT redacted_json FROM trace_event_spool")
      .all()
      .map((row) => row.redacted_json)
      .join("\n");
    expect(token).not.toBeNull();
    expect(traceJson).not.toContain(token!);
  });

  it("opens Google OAuth through the deployed public listener over an SSH tunnel", async () => {
    const harness = await localUiHarness({
      publicBaseUrl: "https://assistant.example.com",
    });
    const root = await getRoot(harness);
    const response = await postForm(harness, "/connections/google", {
      csrf: csrfFrom(root.body),
    });

    expect(root.body).toContain(
      '<button class="button button-secondary" type="submit">Add Google account</button>',
    );
    expect(root.headers["content-security-policy"]).toContain(
      "form-action 'self' https://assistant.example.com https://accounts.google.com",
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toMatch(
      /^https:\/\/assistant\.example\.com\/connect\/google\?token=/u,
    );
  });

  it("normalizes saves, reports unchanged documents, and traces both outcomes", async () => {
    const harness = await localUiHarness();
    const csrf = csrfFrom((await getRoot(harness)).body);
    const before = await harness.memory.loadSnapshot();
    const saved = await postForm(harness, "/memory", {
      csrf,
      expectedRevision: before.revision,
      content: "# Memory\r\n\r\n## User\r\n- Likes tea  ",
    });

    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe("/?notice=saved#status");
    await expect(harness.memory.load()).resolves.toBe("# Memory\n\n## User\n- Likes tea\n");

    const current = await harness.memory.loadSnapshot();
    const unchanged = await postForm(harness, "/memory", {
      csrf,
      expectedRevision: current.revision,
      content: current.content,
    });
    expect(unchanged.statusCode).toBe(303);
    expect(unchanged.headers.location).toBe("/?notice=unchanged#status");

    const events = harness.database.handle.db
      .prepare<[], { outcome: string; redacted_json: string }>(`
        SELECT outcome, redacted_json FROM trace_event_spool
        WHERE component = 'memory' AND event = 'manual_edit'
        ORDER BY occurred_at_ms, sequence
      `)
      .all();
    expect(events.map((event) => event.outcome)).toEqual([
      "attempting",
      "updated",
      "attempting",
      "unchanged",
    ]);
    const updated = JSON.parse(events[1]?.redacted_json ?? "{}") as {
      beforeRevision?: unknown;
      afterRevision?: unknown;
      diff?: unknown;
    };
    expect(updated.beforeRevision).toBe(before.revision);
    expect(updated.afterRevision).toBe(current.revision);
    expect(updated.diff).toEqual(expect.stringContaining("+## User"));
    expect(updated.diff).toEqual(expect.stringContaining("+- Likes tea"));
  });

  it("preserves both documents on a stale revision without offering an overwrite", async () => {
    const harness = await localUiHarness();
    const csrf = csrfFrom((await getRoot(harness)).body);
    const stale = await harness.memory.loadSnapshot();
    const external = harness.memory.prepareReplacement("# Memory\n\n- Newer edit\n");
    await harness.memory.replaceIfRevision(stale.revision, external);

    const response = await postForm(harness, "/memory", {
      csrf,
      expectedRevision: stale.revision,
      content: "# Memory\n\n- Unsaved browser draft\n",
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("Newer edit");
    expect(response.body).toContain("Unsaved browser draft");
    expect(response.body).toContain('<a class="button button-primary" href="/">Reload</a>');
    expect(response.body).not.toContain('action="/memory"');
    await expect(harness.memory.load()).resolves.toBe("# Memory\n\n- Newer edit\n");
  });

  it("rejects secret-bearing memory without reflecting the secret", async () => {
    const harness = await localUiHarness();
    const csrf = csrfFrom((await getRoot(harness)).body);
    const before = await harness.memory.loadSnapshot();
    const secret = "configured-secret-value";
    const response = await postForm(harness, "/memory", {
      csrf,
      expectedRevision: before.revision,
      content: `# Memory\n\n- ${secret}\n`,
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("credential-like text");
    expect(response.body).not.toContain(secret);
    const malformed = await postForm(harness, "/memory", {
      csrf,
      expectedRevision: before.revision,
      content: `# Wrong heading\n\n- ${secret}\n`,
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.body).toContain("Start with exactly");
    expect(malformed.body).not.toContain(secret);
    await expect(harness.memory.load()).resolves.toBe(before.content);
  });

  it("preserves an oversized safe draft so the user can trim and resubmit it", async () => {
    const harness = await localUiHarness();
    const csrf = csrfFrom((await getRoot(harness)).body);
    const before = await harness.memory.loadSnapshot();
    const oversized = `# Memory\n\n- keep-this-draft ${"x".repeat(16_384)}\n`;

    const response = await postForm(harness, "/memory", {
      csrf,
      expectedRevision: before.revision,
      content: oversized,
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("exceeds the configured byte limit");
    expect(response.body).toContain("keep-this-draft");
    expect(response.body).toContain(
      '<button class="button button-primary" type="submit">Save</button>',
    );
    await expect(harness.memory.loadSnapshot()).resolves.toEqual(before);
  });

  it("disables controls and refuses mutations until the shared runtime is ready", async () => {
    const harness = await localUiHarness({ ready: false });
    const root = await getRoot(harness);
    expect(root.body).toContain("Starting");
    expect(root.body).toContain("disabled");
    const response = await postForm(harness, "/connections/google", {
      csrf: csrfFrom(root.body),
    });
    expect(response.statusCode).toBe(503);
  });

  it("binds a real listener only to IPv4 loopback", async () => {
    const harness = await localUiHarness({ port: 0 });
    await harness.app.listen({ host: harness.config.host, port: 0 });
    const address = harness.app.server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Annie");

    await harness.app.close();
    await expect(fetch(`http://127.0.0.1:${address.port}/`)).rejects.toThrow();
  });
});

interface LocalUiHarness {
  app: FastifyInstance;
  config: LocalUiConfig;
  database: TestDatabase;
  connections: ConnectionStore;
  memory: MemoryDocumentStore;
}

async function localUiHarness(
  options: { ready?: boolean; port?: number; publicBaseUrl?: string } = {},
): Promise<LocalUiHarness> {
  const database = createTestDatabase();
  databases.push(database);
  const traces = new TraceStore(
    database.handle.db,
    createTraceRedactor(["configured-secret-value"]),
  );
  const vault = new CredentialVault(Buffer.alloc(32, 7));
  const connections = new ConnectionStore(database.handle.db, vault, traces);
  const memory = new MemoryDocumentStore({
    path: database.config.memoryPath,
    maximumBytes: 16_384,
    forbiddenValues: ["configured-secret-value"],
  });
  await memory.repairAndLoad();
  const port = options.port ?? 3001;
  const config: LocalUiConfig = {
    host: "127.0.0.1",
    port,
    authority: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
  };
  const publicBaseUrl = options.publicBaseUrl ?? "http://127.0.0.1:3000";
  const app = createLocalUiApp({
    config,
    publicBaseUrl,
    memoryMaximumBytes: 16_384,
    connections,
    links: new ConnectLinkService({
      db: database.handle.db,
      signingKey: vault.linkSigningKey(),
      publicBaseUrl,
      traces,
      ttlMs: 600_000,
    }),
    memory,
    traces,
    isReady: () => options.ready ?? true,
  });
  await app.ready();
  apps.push(app);
  return { app, config, database, connections, memory };
}

async function getRoot(harness: LocalUiHarness) {
  return harness.app.inject({
    method: "GET",
    url: "/",
    headers: { host: harness.config.authority },
  });
}

async function postForm(
  harness: LocalUiHarness,
  path: string,
  values: Record<string, string>,
  origin: string = harness.config.origin,
) {
  return harness.app.inject({
    method: "POST",
    url: path,
    headers: {
      host: harness.config.authority,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams(values).toString(),
  });
}

function csrfFrom(html: string): string {
  const match = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(html);
  if (match?.[1] === undefined) {
    throw new Error("Local UI page did not contain a CSRF token");
  }
  return match[1];
}
