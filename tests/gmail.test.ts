import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunStore } from "../src/agent/store.js";
import type { ToolExecutionContext } from "../src/agent/tools.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import { ConnectionRouter } from "../src/connections/router.js";
import { ConnectionStore } from "../src/connections/store.js";
import type { RefreshCoordinator } from "../src/connections/refresh.js";
import {
  newInboundId,
  newTraceId,
  type ConnectionId,
  type InboundId,
  type TraceId,
} from "../src/core/ids.js";
import {
  GoogleGmailClientProvider,
  type GmailApi,
  type GmailClientProvider,
} from "../src/gmail/client.js";
import { GmailToolService } from "../src/gmail/tools.js";
import { normalizeGmailMetadata, normalizeGmailThread } from "../src/gmail/normalize.js";
import { CredentialVault } from "../src/security/vault.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe("Gmail read tools", () => {
  it("routes an explicit account and returns bounded normalized search results", async () => {
    const harness = gmailHarness();
    expect(harness.config.google.scopes).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/tasks.readonly",
    ]);
    const work = addGoogleConnection(harness, "sub_work", "Work", "work@example.test");
    const personal = addGoogleConnection(
      harness,
      "sub_personal",
      "Personal",
      "personal@example.test",
    );
    const selected: ConnectionId[] = [];
    const api = stubGmailApi({
      async listMessages(input) {
        expect(input).toEqual({ query: "from:alice", maxResults: 5 });
        return response({ messages: [{ id: "message_1", threadId: "thread_1" }], resultSizeEstimate: 1 });
      },
      async getMessage(input) {
        expect(input).toMatchObject({ messageId: "message_1", format: "metadata" });
        return response({
          id: "message_1",
          threadId: "thread_1",
          labelIds: ["INBOX", "IMPORTANT"],
          snippet: "A short result",
          payload: {
            headers: [
              { name: "From", value: "Alice <alice@example.test>" },
              { name: "To", value: "personal@example.test" },
              { name: "Subject", value: "Quarterly plan" },
              { name: "Date", value: "Fri, 29 Aug 2026 10:00:00 +0000" },
              { name: "Message-ID", value: "<provider-message@example.test>" },
            ],
          },
        });
      },
    });
    const service = gmailService(harness, {
      async forConnection(connectionId) {
        selected.push(connectionId);
        return api;
      },
    });
    const context = toolContext(harness, "gmail.search");

    await expect(
      service.search({ query: "from:alice", account: "Personal", maxResults: 5 }, context),
    ).resolves.toEqual({
      account: { label: "Personal" },
      resultSizeEstimate: 1,
      messages: [
        {
          id: "message_1",
          threadId: "thread_1",
          from: "Alice <alice@example.test>",
          to: "personal@example.test",
          subject: "Quarterly plan",
          date: "Fri, 29 Aug 2026 10:00:00 +0000",
          messageId: "<provider-message@example.test>",
          snippet: "A short result",
          labels: ["IMPORTANT", "INBOX"],
        },
      ],
      messagesTruncated: false,
    });
    expect(selected).toEqual([personal.id]);
    expect(selected).not.toContain(work.id);
    expect(harness.runs.getToolRequired(context.toolExecutionId).connectionId).toBe(personal.id);
  });

  it("fetches message metadata in bounded concurrent waves and preserves list order", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_parallel",
      "Parallel",
      "parallel@example.test",
    );
    const ids = Array.from({ length: 7 }, (_, index) => `message_${index + 1}`);
    let active = 0;
    let maximumActive = 0;
    const firstWaveStarted = Promise.withResolvers<void>();
    let started = 0;
    const api = stubGmailApi({
      async listMessages() {
        return response({
          messages: ids.map((id) => ({ id, threadId: `thread_${id}` })),
          resultSizeEstimate: ids.length,
        });
      },
      async getMessage(input) {
        active += 1;
        started += 1;
        maximumActive = Math.max(maximumActive, active);
        if (started === 5) {
          firstWaveStarted.resolve();
        }
        await firstWaveStarted.promise;
        active -= 1;
        return response({ id: input.messageId, snippet: input.messageId });
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));

    const result = (await service.search(
      { query: "is:unread", maxResults: ids.length },
      toolContext(harness, "gmail.search"),
    )) as { messages: readonly { id: string }[] };

    expect(maximumActive).toBe(5);
    expect(result.messages.map((message) => message.id)).toEqual(ids);
  });

  it("hydrates only top distinct threads within per-thread and total result bounds", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_hydration",
      "Hydration",
      "hydration@example.test",
    );
    const threadReads: string[] = [];
    const largeBody = Buffer.from("important detail ".repeat(10_000)).toString("base64url");
    const api = stubGmailApi({
      async listMessages() {
        return response({
          messages: [
            { id: "message_1", threadId: "thread_1" },
            { id: "message_2", threadId: "thread_1" },
            { id: "message_3", threadId: "thread_2" },
          ],
          resultSizeEstimate: 3,
        });
      },
      async getMessage(input) {
        return response({
          id: input.messageId,
          threadId: input.messageId === "message_3" ? "thread_2" : "thread_1",
          snippet: input.messageId,
        });
      },
      async getThread(input) {
        threadReads.push(input.threadId);
        return response({
          id: input.threadId,
          messages: Array.from({ length: 10 }, (_, index) => ({
            id: `${input.threadId}_message_${index}`,
            threadId: input.threadId,
            payload: { mimeType: "text/plain", body: { data: largeBody } },
          })),
        });
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));

    const result = (await service.search(
      { query: "from:alice launch", maxResults: 3, hydrateThreads: 2 },
      toolContext(harness, "gmail.search"),
    )) as {
      messages: readonly unknown[];
      hydration: {
        requested: number;
        truncated: boolean;
        threads: readonly { threadId: string; thread: unknown }[];
      };
    };

    expect(threadReads).toEqual(["thread_1", "thread_2"]);
    expect(result.messages).toHaveLength(3);
    expect(result.hydration).toMatchObject({ requested: 2, truncated: true });
    expect(result.hydration.threads.map((item) => item.threadId)).toEqual([
      "thread_1",
      "thread_2",
    ]);
    for (const item of result.hydration.threads) {
      expect(Buffer.byteLength(JSON.stringify(item.thread))).toBeLessThanOrEqual(8 * 1_024);
    }
    expect(Buffer.byteLength(JSON.stringify(result.hydration))).toBeLessThanOrEqual(24 * 1_024);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(120 * 1_024);
  });

  it("keeps metadata when optional hydration fails", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_hydration_failure",
      "Hydration failure",
      "hydration-failure@example.test",
    );
    const api = stubGmailApi({
      async listMessages() {
        return response({
          messages: [{ id: "message_1", threadId: "thread_1" }],
          resultSizeEstimate: 1,
        });
      },
      async getMessage() {
        return response({ id: "message_1", threadId: "thread_1", snippet: "metadata survives" });
      },
      async getThread() {
        throw providerError(400);
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));

    await expect(
      service.search(
        { query: "from:alice", maxResults: 1, hydrateThreads: 1 },
        toolContext(harness, "gmail.search"),
      ),
    ).resolves.toMatchObject({
      messages: [{ id: "message_1", snippet: "metadata survives" }],
      hydration: { requested: 1, truncated: true, threads: [] },
    });
  });
  it("does not downgrade a run abort into optional hydration loss", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_hydration_abort",
      "Hydration abort",
      "hydration-abort@example.test",
    );
    const controller = new AbortController();
    const api = stubGmailApi({
      async listMessages() {
        return response({
          messages: [{ id: "message_1", threadId: "thread_1" }],
          resultSizeEstimate: 1,
        });
      },
      async getMessage() {
        return response({ id: "message_1", threadId: "thread_1" });
      },
      async getThread() {
        controller.abort();
        controller.signal.throwIfAborted();
        throw new Error("unreachable");
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));
    const context = {
      ...toolContext(harness, "gmail.search"),
      signal: controller.signal,
    };

    await expect(
      service.search(
        { query: "from:alice", maxResults: 1, hydrateThreads: 1 },
        context,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      harness.traces
        .list(context.traceId)
        .some((event) => event.component === "gmail" && event.event === "hydration_skipped"),
    ).toBe(false);
  });


  it("normalizes plain text, HTML fallback, and attachment metadata in a thread", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(harness, "sub_thread", "Thread", "thread@example.test");
    const api = stubGmailApi({
      async getThread() {
        return response({
          id: "thread_7",
          historyId: "history_9",
          messages: [
            {
              id: "message_plain",
              threadId: "thread_7",
              snippet: "plain",
              payload: {
                mimeType: "multipart/mixed",
                headers: [{ name: "Subject", value: "Mixed content" }],
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { data: Buffer.from("Plain body").toString("base64url") },
                  },
                  {
                    mimeType: "application/pdf",
                    filename: "brief.pdf",
                    body: { size: 1234, attachmentId: "attachment_1" },
                  },
                ],
              },
            },
            {
              id: "message_html",
              threadId: "thread_7",
              snippet: "html",
              payload: {
                mimeType: "text/html",
                body: {
                  data: Buffer.from("<p>Hello <strong>world</strong></p>").toString("base64url"),
                },
              },
            },
          ],
        });
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));
    const context = toolContext(harness, "gmail.read_thread");
    const result = await service.readThread({ threadId: "thread_7" }, context);

    expect(result).toMatchObject({
      account: { label: "Thread" },
      thread: {
        id: "thread_7",
        historyId: "history_9",
        messagesTruncated: false,
        messages: [
          {
            id: "message_plain",
            subject: "Mixed content",
            bodyText: "Plain body",
            bodyTruncated: false,
            attachments: [
              {
                filename: "brief.pdf",
                mimeType: "application/pdf",
                size: 1234,
                attachmentId: "attachment_1",
              },
            ],
          },
          {
            id: "message_html",
            bodyText: "Hello world",
            bodyTruncated: false,
          },
        ],
      },
    });
  });

  it("bounds provider-controlled metadata and the aggregate normalized thread", () => {
    const metadata = normalizeGmailMetadata({
      id: "m".repeat(2_000),
      threadId: "t".repeat(2_000),
      labelIds: Array.from({ length: 200 }, (_, index) => `label-${index}-${"x".repeat(200)}`),
      payload: {
        headers: [
          { name: "From", value: "f".repeat(10_000) },
          { name: "To", value: "t".repeat(10_000) },
          { name: "Subject", value: "s".repeat(10_000) },
          { name: "Date", value: "d".repeat(10_000) },
          { name: "Message-ID", value: "i".repeat(10_000) },
        ],
      },
    });
    expect(Buffer.byteLength(metadata.id)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(metadata.threadId ?? "")).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(metadata.from ?? "")).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(metadata.to ?? "")).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(metadata.subject ?? "")).toBeLessThanOrEqual(1_024);
    expect(metadata.labels).toHaveLength(50);
    expect(metadata.labels.every((label) => Buffer.byteLength(label) <= 128)).toBe(true);

    const attachmentParts = Array.from({ length: 100 }, (_, index) => ({
      mimeType: "application/octet-stream",
      filename: `attachment-${index}-${"x".repeat(1_000)}`,
      body: { size: 10, attachmentId: `attachment-${index}-${"y".repeat(1_000)}` },
    }));
    const largeBody = Buffer.from("body ".repeat(50_000)).toString("base64url");
    const thread = normalizeGmailThread({
      id: "thread_bounded",
      messages: Array.from({ length: 10 }, (_, index) => ({
        id: `message_${index}`,
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: largeBody } },
            ...attachmentParts,
          ],
        },
      })),
    });
    expect(
      thread.messages.reduce((count, message) => count + message.attachments.length, 0),
    ).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(thread))).toBeLessThanOrEqual(120 * 1_024);
  });

  it("bounds full-thread transport before parsing and requests only required fields", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_transport_bound",
      "Transport Bound",
      "transport@example.test",
    );
    const refresh = {
      async credentials() {
        return {
          accessToken: "synthetic-access-token",
          refreshToken: "synthetic-refresh-token",
          scopes: harness.config.google.scopes,
        };
      },
    } as unknown as RefreshCoordinator;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    let chunksRead = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      const chunk = new Uint8Array(1_024 * 1_024).fill(123);
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunksRead += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new GoogleGmailClientProvider(harness.config, refresh, fetchImpl);
    const api = await provider.forConnection(connection.id, newTraceId());

    await expect(api.getThread({ threadId: "thread/one" })).rejects.toMatchObject({
      name: "GmailHttpError",
      response: { status: 413 },
    });
    const url = new URL(requestUrl);
    expect(url.origin).toBe("https://gmail.googleapis.com");
    expect(url.pathname).toBe("/gmail/v1/users/me/threads/thread%2Fone");
    expect(url.searchParams.get("format")).toBe("full");
    expect(url.searchParams.get("fields")).toBe(
      "id,historyId,messages(id,threadId,labelIds,snippet,internalDate,payload)",
    );
    expect(requestInit?.method).toBe("GET");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer synthetic-access-token",
    );
    expect(chunksRead).toBeGreaterThan(8);
  });

  it.each([429, 500, 503])("retries read-only Gmail HTTP %s responses", async (status) => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(harness, `sub_retry_${status}`, "Retry", "retry@example.test");
    let requests = 0;
    const waits: number[] = [];
    const api = stubGmailApi({
      async listMessages() {
        requests += 1;
        if (requests < 3) {
          throw providerError(status);
        }
        return response({ messages: [] });
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api), waits);
    const context = toolContext(harness, "gmail.search");

    await expect(service.search({ query: "is:unread", maxResults: 10 }, context)).resolves.toMatchObject({
      messages: [],
    });
    expect(requests).toBe(3);
    expect(waits).toEqual([250, 500]);
  });

  it("honors a bounded Retry-After header on Gmail rate limits", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_retry_after",
      "Retry After",
      "retry-after@example.test",
    );
    let requests = 0;
    const waits: number[] = [];
    const api = stubGmailApi({
      async listMessages() {
        requests += 1;
        if (requests === 1) {
          throw providerError(429, new Headers({ "retry-after": "2" }));
        }
        return { data: { messages: [] }, headers: new Headers({ "x-request-id": "req_ok" }) };
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api), waits);

    await expect(
      service.search(
        { query: "is:unread", maxResults: 10 },
        toolContext(harness, "gmail.search"),
      ),
    ).resolves.toMatchObject({ messages: [] });
    expect(requests).toBe(2);
    expect(waits).toEqual([2_000]);
  });
});


interface GmailHarness {
  database: TestDatabase;
  config: RuntimeConfig;
  traces: TraceStore;
  connections: ConnectionStore;
  router: ConnectionRouter;
  runs: AgentRunStore;
  nextSequence: number;
}

function gmailHarness(): GmailHarness {
  const database = createTestDatabase();
  databases.push(database);
  const config = testRuntimeConfig(database);
  const traces = new TraceStore(database.handle.db, createTraceRedactor([config.gemini.apiKey]));
  const connections = new ConnectionStore(
    database.handle.db,
    new CredentialVault(Buffer.alloc(32, 19)),
    traces,
  );
  return {
    database,
    config,
    traces,
    connections,
    router: new ConnectionRouter(connections),
    runs: new AgentRunStore(database.handle.db, traces),
    nextSequence: 1,
  };
}

function addGoogleConnection(
  harness: GmailHarness,
  providerAccountId: string,
  safeLabel: string,
  email: string,
) {
  return harness.connections.saveAuthorization({
    traceId: newTraceId(),
    provider: "google",
    providerAccountId,
    safeLabel,
    safeMetadata: { email },
    providerState: { scopes: harness.config.google.scopes },
    capabilities: ["gmail.read"],
    credentials: {
      accessToken: `access-${providerAccountId}`,
      refreshToken: `refresh-${providerAccountId}`,
      scopes: harness.config.google.scopes,
    },
    expiresAtMs: Date.now() + 3_600_000,
  });
}

function gmailService(
  harness: GmailHarness,
  clients: GmailClientProvider,
  waits: number[] = [],
): GmailToolService {
  return new GmailToolService({
    router: harness.router,
    connections: harness.connections,
    clients,
    runs: harness.runs,
    traces: harness.traces,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
}

function fixedClient(connectionId: ConnectionId, api: GmailApi): GmailClientProvider {
  return {
    async forConnection(selected) {
      expect(selected).toBe(connectionId);
      return api;
    },
  };
}

function stubGmailApi(overrides: Partial<GmailApi>): GmailApi {
  return {
    async listMessages() {
      throw new Error("Unexpected messages.list");
    },
    async getMessage() {
      throw new Error("Unexpected messages.get");
    },
    async getThread() {
      throw new Error("Unexpected threads.get");
    },
    ...overrides,
  };
}

function response(data: unknown) {
  return { data, headers: { "x-request-id": `request_${randomUUID()}` } };
}

function providerError(
  status: number,
  headers?: Headers,
): Error & { response: { status: number; headers?: Headers } } {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, ...(headers === undefined ? {} : { headers }) },
  });
}

function toolContext(harness: GmailHarness, toolName: string): ToolExecutionContext {
  const inbound = insertInbound(harness, toolName);
  const run = harness.runs.startOrResume({
    source: { kind: "inbound", inboundId: inbound.inboundId },
    traceId: inbound.traceId,
    deadlineAtMs: Date.now() + 60_000,
  });
  const call = {
    id: `call_${randomUUID()}`,
    name: toolName,
    argumentsJson: "{}",
  };
  const execution = harness.runs.prepareTool({
    runId: run.id,
    call,
    operationClass: "read",
    maximumToolCalls: 16,
  });
  harness.runs.markToolRunning(execution.id);
  return {
    runId: run.id,
    traceId: inbound.traceId,
    toolExecutionId: execution.id,
    connectionId: null,
    replay: false,
  };
}

function insertInbound(
  harness: GmailHarness,
  text: string,
): { inboundId: InboundId; traceId: TraceId } {
  const inboundId = newInboundId();
  const traceId = newTraceId();
  const deliveryId = `delivery_${randomUUID()}`;
  const providerMessageId = `message_${randomUUID()}`;
  const now = Date.now();
  const sequence = harness.nextSequence;
  harness.nextSequence += 1;
  harness.traces.append({
    traceId,
    component: "test",
    event: "inbound_fixture",
    outcome: "ready",
    data: {},
  });
  const transaction = harness.database.handle.db.transaction(() => {
    harness.database.handle.db
      .prepare(`
        INSERT INTO webhook_deliveries(
          id, provider_delivery_id, provider_message_id, event_kind, line_id,
          line_handle, outbox_id, normalized_json, trace_id, received_at_ms
        ) VALUES (?, ?, ?, 'message.created', 'line_test', '+15551110000', NULL, '{}', ?, ?)
      `)
      .run(deliveryId, deliveryId, providerMessageId, traceId, now);
    harness.database.handle.db
      .prepare(`
        INSERT INTO inbound_messages(
          id, delivery_id, provider_message_id, chat_id, guid, sender,
          line_id, line_handle, sequence, state, text, is_audio,
          attachment_json, trace_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'chat_test', ?, '+15559990000',
                  'line_test', '+15551110000', ?, 'ready', ?, 0,
                  NULL, ?, ?, ?)
      `)
      .run(
        inboundId,
        deliveryId,
        providerMessageId,
        providerMessageId,
        sequence,
        text,
        traceId,
        now,
        now,
      );
  });
  transaction.immediate();
  return { inboundId, traceId };
}

function testRuntimeConfig(database: TestDatabase): RuntimeConfig {
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
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
}
