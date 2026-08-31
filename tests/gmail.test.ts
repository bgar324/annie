import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunStore } from "../src/agent/store.js";
import { ToolRegistry, type ToolExecutionContext } from "../src/agent/tools.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import { ConnectionRouter } from "../src/connections/router.js";
import { ConnectionStore } from "../src/connections/store.js";
import {
  newInboundId,
  newTraceId,
  type ConnectionId,
  type InboundId,
  type RunId,
  type TraceId,
} from "../src/core/ids.js";
import type { GmailApi, GmailClientProvider } from "../src/gmail/client.js";
import { GmailToolService } from "../src/gmail/tools.js";
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

describe("Gmail read tools", () => {
  it("routes an explicit account and returns bounded normalized search results", async () => {
    const harness = gmailHarness();
    expect(harness.config.google.scopes).toEqual([
      "email",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
      "openid",
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
    const context = toolContext(harness, "gmail.search", "read");

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
    });
    expect(selected).toEqual([personal.id]);
    expect(selected).not.toContain(work.id);
    expect(harness.runs.getToolRequired(context.toolExecutionId).connectionId).toBe(personal.id);
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
    const context = toolContext(harness, "gmail.read_thread", "read");
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
    const context = toolContext(harness, "gmail.search", "read");

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
        toolContext(harness, "gmail.search", "read"),
      ),
    ).resolves.toMatchObject({ messages: [] });
    expect(requests).toBe(2);
    expect(waits).toEqual([2_000]);
  });
});

describe("Gmail draft writes", () => {
  it("creates then sends a known draft with two one-attempt write intents", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(harness, "sub_writer", "Writer", "writer@example.test");
    const rawMessages: string[] = [];
    let createRequests = 0;
    let sendRequests = 0;
    const api = stubGmailApi({
      async createDraft(input) {
        createRequests += 1;
        rawMessages.push(Buffer.from(input.raw, "base64url").toString("utf8"));
        return response({
          id: "draft_1",
          message: { id: "provider_draft_message", threadId: "thread_draft" },
        });
      },
      async sendDraft(input) {
        sendRequests += 1;
        expect(input.draftId).toBe("draft_1");
        return response({ id: "sent_message", threadId: "thread_draft", labelIds: ["SENT"] });
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));
    const createContext = toolContext(harness, "gmail.create_draft", "write");
    const created = await service.createDraft(
      {
        to: ["recipient@example.test"],
        subject: "Hello",
        bodyText: "Draft body",
      },
      createContext,
    );
    const sendContext = toolContext(harness, "gmail.send_draft", "write", createContext.runId);
    const sent = await service.sendDraft({ draftId: "draft_1" }, sendContext);

    expect(created).toMatchObject({ ok: true, draftId: "draft_1", threadId: "thread_draft" });
    expect(sent).toMatchObject({ ok: true, draftId: "draft_1", messageId: "sent_message" });
    expect(createRequests).toBe(1);
    expect(sendRequests).toBe(1);
    expect(rawMessages[0]).toMatch(/^From: writer@example\.test/mu);
    expect(rawMessages[0]).toMatch(/^To: recipient@example\.test/mu);
    expect(rawMessages[0]).toMatch(/^Subject: Hello/mu);
    expect(rawMessages[0]).toContain(
      `Message-ID: <${createContext.toolExecutionId}@assistant.example>`,
    );
    expect(rawMessages[0]).toContain("Draft body");
    expect(service.tools().map((tool) => tool.definition.name)).toEqual([
      "gmail.search",
      "gmail.read_thread",
      "gmail.create_draft",
      "gmail.send_draft",
    ]);
    expect(() => new ToolRegistry(service.tools())).not.toThrow();
    expect(
      harness.database.handle.db
        .prepare<[], { state: string }>("SELECT state FROM write_intents ORDER BY created_at_ms")
        .all(),
    ).toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
    expect(
      harness.database.handle.db
        .prepare<[], { status: string; sent_message_id: string }>(`
          SELECT status, sent_message_id FROM gmail_drafts WHERE provider_draft_id = 'draft_1'
        `)
        .get(),
    ).toEqual({ status: "sent", sent_message_id: "sent_message" });
    expect(harness.runs.getToolRequired(createContext.toolExecutionId).status).toBe("succeeded");
    expect(harness.runs.getToolRequired(sendContext.toolExecutionId).status).toBe("succeeded");
    expect(JSON.stringify(harness.traces.list(createContext.traceId))).not.toContain("Draft body");
  });

  it("reuses the exact persisted MIME when resuming before dispatch", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_resume",
      "Resume",
      "resume@example.test",
    );
    const context = toolContext(harness, "gmail.create_draft", "write");
    const persistedRequest = {
      raw: Buffer.from("persisted MIME", "utf8").toString("base64url"),
      threadId: "thread_persisted",
      rfcMessageId: "<persisted@assistant.example>",
    };
    harness.writes.prepare({
      traceId: context.traceId,
      runId: context.runId,
      toolExecutionId: context.toolExecutionId,
      connectionId: connection.id,
      connectionGeneration: connection.credentialGeneration,
      kind: "gmail_create_draft",
      request: persistedRequest,
      safeSummary: { test: true },
    });
    let receivedRequest: unknown;
    const api = stubGmailApi({
      async createDraft(input) {
        receivedRequest = input;
        return response({
          id: "draft_resumed",
          message: { id: "message_resumed", threadId: "thread_persisted" },
        });
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));

    await expect(
      service.createDraft(
        {
          to: ["different@example.test"],
          subject: "Would recompose",
          bodyText: "This content must not replace the persisted request",
        },
        context,
      ),
    ).resolves.toMatchObject({ ok: true, draftId: "draft_resumed" });
    expect(receivedRequest).toEqual({
      raw: persistedRequest.raw,
      threadId: persistedRequest.threadId,
    });
    const completedWrite = harness.writes.getByToolExecution(context.toolExecutionId);
    expect(completedWrite?.request).toEqual(persistedRequest);
    expect(completedWrite?.state).toBe("succeeded");
  });

  it("refuses to send a draft that the assistant did not create", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(harness, "sub_safe", "Safe", "safe@example.test");
    let sends = 0;
    const api = stubGmailApi({
      async sendDraft() {
        sends += 1;
        return response({ id: "should_not_send" });
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));
    const context = toolContext(harness, "gmail.send_draft", "write");

    await expect(service.sendDraft({ draftId: "foreign_draft" }, context)).rejects.toMatchObject({
      code: "draft_not_sendable",
    });
    expect(sends).toBe(0);
    expect(
      harness.database.handle.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM write_intents")
        .get()?.count,
    ).toBe(0);
  });

  it("marks a response-loss draft creation ambiguous and never retries it", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_ambiguous",
      "Ambiguous",
      "ambiguous@example.test",
    );
    let creates = 0;
    const api = stubGmailApi({
      async createDraft() {
        creates += 1;
        throw new TypeError("socket closed after dispatch");
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));
    const context = toolContext(harness, "gmail.create_draft", "write");

    await expect(
      service.createDraft(
        { to: ["recipient@example.test"], subject: "One attempt", bodyText: "Only once" },
        context,
      ),
    ).rejects.toThrow("socket closed after dispatch");
    expect(creates).toBe(1);
    expect(
      harness.database.handle.db
        .prepare<[], { state: string }>("SELECT state FROM write_intents")
        .get()?.state,
    ).toBe("ambiguous");
    expect(harness.runs.getToolRequired(context.toolExecutionId).status).toBe("ambiguous");
  });

  it("treats a Gmail server error as acceptance-unknown", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_rejected",
      "Rejected",
      "rejected@example.test",
    );
    let creates = 0;
    const api = stubGmailApi({
      async createDraft() {
        creates += 1;
        throw providerError(503);
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));
    const context = toolContext(harness, "gmail.create_draft", "write");

    await expect(
      service.createDraft(
        { to: ["recipient@example.test"], subject: "Rejected", bodyText: "One try" },
        context,
      ),
    ).rejects.toMatchObject({ response: { status: 503 } });
    expect(creates).toBe(1);
    expect(
      harness.database.handle.db
        .prepare<[], { state: string }>("SELECT state FROM write_intents")
        .get()?.state,
    ).toBe("ambiguous");
  });

  it("records a semantic Gmail rejection as confirmed failed", async () => {
    const harness = gmailHarness();
    const connection = addGoogleConnection(
      harness,
      "sub_bad_request",
      "Bad request",
      "bad-request@example.test",
    );
    const api = stubGmailApi({
      async createDraft() {
        throw providerError(400);
      },
    });
    const service = gmailService(harness, fixedClient(connection.id, api));
    const context = toolContext(harness, "gmail.create_draft", "write");

    await expect(
      service.createDraft(
        { to: ["recipient@example.test"], subject: "Rejected", bodyText: "One try" },
        context,
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
    expect(
      harness.database.handle.db
        .prepare<[], { state: string }>("SELECT state FROM write_intents")
        .get()?.state,
    ).toBe("confirmed_failed");
  });
});

interface GmailHarness {
  database: TestDatabase;
  config: RuntimeConfig;
  traces: TraceStore;
  connections: ConnectionStore;
  router: ConnectionRouter;
  runs: AgentRunStore;
  writes: WriteStore;
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
    writes: new WriteStore(database.handle.db, traces),
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
    capabilities: [
      "gmail.search",
      "gmail.read_thread",
      "gmail.create_draft",
      "gmail.send_draft",
    ],
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
    db: harness.database.handle.db,
    config: harness.config,
    router: harness.router,
    connections: harness.connections,
    clients,
    runs: harness.runs,
    writes: harness.writes,
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
    async createDraft() {
      throw new Error("Unexpected drafts.create");
    },
    async sendDraft() {
      throw new Error("Unexpected drafts.send");
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

function toolContext(
  harness: GmailHarness,
  toolName: string,
  operationClass: "read" | "write",
  existingRunId?: RunId,
): ToolExecutionContext {
  let runId = existingRunId;
  let traceId: TraceId;
  if (runId === undefined) {
    const inbound = insertInbound(harness, toolName);
    traceId = inbound.traceId;
    const run = harness.runs.startOrResume({
      inboundId: inbound.inboundId,
      traceId,
      deadlineAtMs: Date.now() + 60_000,
    });
    runId = run.id;
  } else {
    traceId = harness.runs.getRequired(runId).traceId;
  }
  const call = {
    id: `call_${randomUUID()}`,
    name: toolName,
    argumentsJson: "{}",
  };
  const execution = harness.runs.prepareTool({
    runId,
    call,
    operationClass,
    maximumToolCalls: 8,
  });
  harness.runs.markToolRunning(execution.id);
  return {
    runId,
    traceId,
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
    GOOGLE_WORKSPACE_SCOPES:
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
}
