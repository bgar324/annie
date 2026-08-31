import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunStore } from "../src/agent/store.js";
import { ToolRegistry, ToolRegistryError, type ToolExecutionContext } from "../src/agent/tools.js";
import { ConnectionRouter } from "../src/connections/router.js";
import { ConnectionStore } from "../src/connections/store.js";
import type { ConnectionId, InboundId, TraceId } from "../src/core/ids.js";
import { newInboundId, newTraceId } from "../src/core/ids.js";
import type {
  GoogleWorkspaceApi,
  GoogleWorkspaceClientProvider,
} from "../src/google/client.js";
import { parseDriveFile } from "../src/google/normalize.js";
import { GoogleWorkspaceToolService } from "../src/google/tools.js";
import { CredentialVault } from "../src/security/vault.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];

const googleScopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/tasks.readonly",
] as const;

const allGoogleCapabilities = [
  "gmail.read",
  "calendar.read",
  "drive.read",
  "contacts.read",
  "tasks.read",
] as const;

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe("Google Workspace read tools", () => {
  it("runs a four-product batch on one exact account and returns bounded normalized data", async () => {
    const harness = workspaceHarness();
    const connection = addGoogleConnection(harness, "sub_work", "Work");
    const calls: string[] = [];
    const driveInputs: { query: string; orderByModifiedTime: boolean }[] = [];
    const api = stubWorkspaceApi({
      async listCalendars() {
        calls.push("calendar.list");
        return response({
          items: [{ id: "primary", summary: "Primary", primary: true, timeZone: "America/Chicago" }],
        });
      },
      async listEvents(input) {
        expect(Reflect.get(input, "maxAttendees")).toBe(20);
        calls.push("calendar.events");
        return response({
          items: [
            {
              id: "event_1",
              summary: "Design review",
              description: "Review the launch plan",
              start: { dateTime: "2026-06-02T09:00:00-05:00", timeZone: "America/Chicago" },
              end: { dateTime: "2026-06-02T09:30:00-05:00", timeZone: "America/Chicago" },
              attendees: [{ email: "reviewer@example.test", responseStatus: "accepted" }],
              attendeesOmitted: true,
            },
          ],
        });
      },
      async listDriveFiles(input) {
        calls.push("drive.list");
        driveInputs.push({ query: input.query, orderByModifiedTime: input.orderByModifiedTime });
        return response({
          incompleteSearch: true,
          files: [
            {
              id: "file_1",
              name: "Launch plan",
              mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-06-02T12:00:00Z",
              size: "90071992547409930",
              capabilities: { canDownload: true },
            },
          ],
        });
      },
      async warmContacts() {
        calls.push("contacts.warm");
        return response({ results: [] });
      },
      async searchContacts() {
        calls.push("contacts.search");
        return response({
          results: [
            {
              person: {
                resourceName: "people/contact_1",
                names: [{ displayName: "Ada Example" }],
                emailAddresses: [{ value: "ada@example.test", type: "work" }],
                biographies: [
                  {
                    value: '<p>Met through <a href="https://secret.example/path">a friend</a><img src="https://secret.example/image"></p>',
                    contentType: "TEXT_HTML",
                  },
                ],
                urls: [{ value: "https://secret.example/profile" }],
              },
            },
          ],
        });
      },
      async listTaskLists() {
        calls.push("tasklists.list");
        return response({ items: [{ id: "list_1", title: "Personal" }] });
      },
      async listTasks() {
        calls.push("tasks.list");
        return response({
          items: [
            {
              id: "task_1",
              title: "Book travel",
              due: "2026-06-03T00:00:00.000Z",
              webViewLink: "https://tasks.google.example/provider-link",
            },
          ],
        });
      },
    });
    const service = workspaceService(harness, fixedClient(connection.id, api));

    const result = await service.search(
      {
        account: "Work",
        queries: [
          {
            product: "calendar",
            timeMin: "2026-06-02T08:00:00-05:00",
            timeMax: "2026-06-03T08:00:00-05:00",
            maxResults: 10,
          },
          { product: "drive", text: "launch's \\plan", maxResults: 10 },
          { product: "contacts", query: "Ada", maxResults: 10 },
          { product: "tasks", includeCompleted: false, maxResults: 10 },
        ],
      },
      toolContext(harness, "google.search"),
    );

    expect(result).toMatchObject({
      account: { label: "Work" },
      results: [
        {
          product: "calendar",
          ok: true,
          events: [
            {
              summary: "Design review",
              start: { kind: "dateTime", value: "2026-06-02T09:00:00-05:00" },
              attendees: [{ email: "reviewer@example.test", responseStatus: "accepted" }],
              attendeesTruncated: true,
            },
          ],
        },
        {
          product: "drive",
          ok: true,
          incomplete: true,
          files: [{ fileId: "file_1", sizeBytes: "90071992547409930", canDownload: true }],
        },
        {
          product: "contacts",
          ok: true,
          contacts: [
            {
              contactId: "people/contact_1",
              displayName: "Ada Example",
              biographies: [{ value: "Met through a friend", contentType: "TEXT_PLAIN" }],
            },
          ],
        },
        {
          product: "tasks",
          ok: true,
          tasks: [{ taskId: "task_1", dueDate: "2026-06-03" }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret.example");
    expect(JSON.stringify(result)).not.toContain("webViewLink");
    expect(driveInputs).toEqual([
      {
        query: "trashed = false and (name contains 'launch\\'s \\\\plan' or fullText contains 'launch\\'s \\\\plan')",
        orderByModifiedTime: false,
      },
    ]);
    expect(calls.indexOf("contacts.warm")).toBeLessThan(calls.indexOf("contacts.search"));
    expect(calls).toEqual(expect.arrayContaining([
      "calendar.list",
      "calendar.events",
      "drive.list",
      "contacts.warm",
      "contacts.search",
      "tasklists.list",
      "tasks.list",
    ]));
  });

  it("orders mixed-offset Calendar events chronologically before the aggregate cap", async () => {
    const harness = workspaceHarness();
    const connection = addGoogleConnection(harness, "sub_calendar_order", "Calendar Order");
    const api = stubWorkspaceApi({
      async listCalendars() {
        return response({
          items: [
            { id: "pacific", summary: "Pacific" },
            { id: "eastern", summary: "Eastern" },
          ],
        });
      },
      async listEvents(input) {
        return response({
          items: input.calendarId === "pacific"
            ? [{
                id: "later_event",
                summary: "Later",
                start: { dateTime: "2026-06-02T09:00:00-07:00" },
                end: { dateTime: "2026-06-02T10:00:00-07:00" },
              }]
            : [{
                id: "earlier_event",
                summary: "Earlier",
                start: { dateTime: "2026-06-02T11:00:00-04:00" },
                end: { dateTime: "2026-06-02T12:00:00-04:00" },
              }],
        });
      },
    });
    const service = workspaceService(harness, fixedClient(connection.id, api));

    await expect(
      service.search(
        {
          account: "Calendar Order",
          queries: [{
            product: "calendar",
            timeMin: "2026-06-02T00:00:00Z",
            timeMax: "2026-06-03T00:00:00Z",
            maxResults: 1,
          }],
        },
        toolContext(harness, "google.search"),
      ),
    ).resolves.toMatchObject({
      results: [{
        product: "calendar",
        events: [{ eventId: "earlier_event" }],
        truncated: true,
      }],
    });
  });

  it("isolates one product failure without skipping later products", async () => {
    const harness = workspaceHarness();
    const connection = addGoogleConnection(harness, "sub_personal", "Personal");
    let contactsSearched = false;
    let tasksSearched = false;
    const api = stubWorkspaceApi({
      async listDriveFiles() {
        throw providerError(403);
      },
      async warmContacts() {
        return response({ results: [] });
      },
      async searchContacts() {
        contactsSearched = true;
        return response({ results: [] });
      },
      async listTaskLists() {
        tasksSearched = true;
        return response({ items: [] });
      },
    });
    const service = workspaceService(harness, fixedClient(connection.id, api));

    const result = await service.search(
      {
        account: "Personal",
        queries: [
          { product: "drive", maxResults: 5 },
          { product: "contacts", query: "A", maxResults: 5 },
          { product: "tasks", includeCompleted: false, maxResults: 5 },
        ],
      },
      toolContext(harness, "google.search"),
    );

    expect(result).toMatchObject({
      results: [
        { product: "drive", ok: false, error: { code: "provider_read_failed" } },
        { product: "contacts", ok: true },
        { product: "tasks", ok: true },
      ],
    });
    expect(contactsSearched).toBe(true);
    expect(tasksSearched).toBe(true);
  });

  it("reads Drive exports, contacts, and tasks without exposing unsupported provider fields", async () => {
    const harness = workspaceHarness();
    const connection = addGoogleConnection(harness, "sub_read", "Read Account");
    const api = stubWorkspaceApi({
      async getDriveFile() {
        return response({
          id: "sheet_1",
          name: "Budget",
          mimeType: "application/vnd.google-apps.spreadsheet",
          capabilities: { canDownload: true },
          clientEncryptionDetails: { encryptionState: "unencrypted" },
        });
      },
      async exportDriveText() {
        return response({ content: "name,amount\ncoffee,4", truncated: false });
      },
      async getContact() {
        return response({
          resourceName: "people/contact_2",
          names: [{ displayName: "Grace Example" }],
          biographies: [{ value: "<b>Colleague</b>", contentType: "TEXT_HTML" }],
        });
      },
      async getTaskList(input) {
        return response({ id: input.taskListId, title: "Work" });
      },
      async getTask(input) {
        return response({ id: input.taskId, title: "Submit report", due: "2026-07-04T00:00:00Z" });
      },
    });
    const service = workspaceService(harness, fixedClient(connection.id, api));

    await expect(
      service.read(
        { product: "drive", fileId: "sheet_1", account: "Read Account" },
        toolContext(harness, "google.read"),
      ),
    ).resolves.toMatchObject({
      product: "drive",
      file: { name: "Budget" },
      content: {
        content: "name,amount\ncoffee,4",
        mimeType: "text/csv",
        warnings: ["CSV export contains only the first sheet"],
      },
    });
    await expect(
      service.read(
        { product: "contacts", contactId: "people/contact_2", account: "Read Account" },
        toolContext(harness, "google.read"),
      ),
    ).resolves.toMatchObject({
      product: "contacts",
      contact: {
        displayName: "Grace Example",
        biographies: [{ value: "Colleague", contentType: "TEXT_PLAIN" }],
      },
    });
    await expect(
      service.read(
        {
          product: "tasks",
          taskListId: "list_2",
          taskId: "task_2",
          account: "Read Account",
        },
        toolContext(harness, "google.read"),
      ),
    ).resolves.toMatchObject({
      product: "tasks",
      task: { title: "Submit report", dueDate: "2026-07-04" },
    });
    expect(() =>
      parseDriveFile({
        id: "future_encryption_state",
        mimeType: "text/plain",
        clientEncryptionDetails: { encryptionState: "future_state" },
      }),
    ).toThrow();
  });

  it("rejects duplicate batch products and a nonexistent Calendar detail branch", async () => {
    const harness = workspaceHarness();
    const connection = addGoogleConnection(harness, "sub_schema", "Schema");
    const service = workspaceService(harness, fixedClient(connection.id, stubWorkspaceApi({})));
    const registry = new ToolRegistry(service.tools());

    await expect(
      registry.execute({
        name: "google.search",
        argumentsJson: JSON.stringify({
          account: "Schema",
          queries: [
            { product: "drive", text: "one" },
            { product: "drive", text: "two" },
          ],
        }),
        context: toolContext(harness, "google.search"),
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    for (const invalidTimestamp of ["2026-06-02", "2026-06-02T09:00:00"]) {
      await expect(
        registry.execute({
          name: "google.search",
          argumentsJson: JSON.stringify({
            account: "Schema",
            queries: [{
              product: "calendar",
              timeMin: invalidTimestamp,
              timeMax: "2026-06-03T09:00:00Z",
            }],
          }),
          context: toolContext(harness, "google.search"),
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
    await expect(
      registry.execute({
        name: "google.read",
        argumentsJson: JSON.stringify({
          product: "calendar",
          calendarId: "primary",
          eventId: "event",
          account: "Schema",
        }),
        context: toolContext(harness, "google.read"),
      }),
    ).rejects.toBeInstanceOf(ToolRegistryError);
  });
});

interface WorkspaceHarness {
  database: TestDatabase;
  traces: TraceStore;
  connections: ConnectionStore;
  router: ConnectionRouter;
  runs: AgentRunStore;
  nextSequence: number;
}

function workspaceHarness(): WorkspaceHarness {
  const database = createTestDatabase();
  databases.push(database);
  const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
  const vault = new CredentialVault(Buffer.alloc(32, 29));
  const connections = new ConnectionStore(database.handle.db, vault, traces);
  return {
    database,
    traces,
    connections,
    router: new ConnectionRouter(connections),
    runs: new AgentRunStore(database.handle.db, traces),
    nextSequence: 1,
  };
}

function addGoogleConnection(
  harness: WorkspaceHarness,
  providerAccountId: string,
  safeLabel: string,
) {
  return harness.connections.saveAuthorization({
    traceId: newTraceId(),
    provider: "google",
    providerAccountId,
    safeLabel,
    safeMetadata: { email: `${providerAccountId}@example.test` },
    providerState: { scopes: googleScopes },
    capabilities: allGoogleCapabilities,
    credentials: {
      accessToken: `access-${providerAccountId}`,
      refreshToken: `refresh-${providerAccountId}`,
      scopes: googleScopes,
    },
    expiresAtMs: Date.now() + 3_600_000,
  });
}

function workspaceService(
  harness: WorkspaceHarness,
  clients: GoogleWorkspaceClientProvider,
): GoogleWorkspaceToolService {
  return new GoogleWorkspaceToolService({
    router: harness.router,
    connections: harness.connections,
    clients,
    runs: harness.runs,
    traces: harness.traces,
    sleep: async () => {},
  });
}

function fixedClient(
  connectionId: ConnectionId,
  api: GoogleWorkspaceApi,
): GoogleWorkspaceClientProvider {
  return {
    async forConnection(selected) {
      expect(selected).toBe(connectionId);
      return api;
    },
  };
}

function stubWorkspaceApi(overrides: Partial<GoogleWorkspaceApi>): GoogleWorkspaceApi {
  const unexpected = (operation: string) => async (): Promise<never> => {
    throw new Error(`Unexpected ${operation}`);
  };
  return {
    listCalendars: unexpected("calendar.calendarList.list"),
    listEvents: unexpected("calendar.events.list"),
    listDriveFiles: unexpected("drive.files.list"),
    getDriveFile: unexpected("drive.files.get"),
    exportDriveText: unexpected("drive.files.export"),
    downloadDriveText: unexpected("drive.files.get.media"),
    warmContacts: unexpected("people.searchContacts warmup"),
    searchContacts: unexpected("people.searchContacts"),
    getContact: unexpected("people.people.get"),
    listTaskLists: unexpected("tasks.tasklists.list"),
    getTaskList: unexpected("tasks.tasklists.get"),
    listTasks: unexpected("tasks.tasks.list"),
    getTask: unexpected("tasks.tasks.get"),
    ...overrides,
  };
}

function response(data: unknown) {
  return { data, headers: { "x-request-id": `request_${randomUUID()}` } };
}

function providerError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

function toolContext(harness: WorkspaceHarness, toolName: string): ToolExecutionContext {
  const inbound = insertInbound(harness, toolName);
  const run = harness.runs.startOrResume({
    source: { kind: "inbound", inboundId: inbound.inboundId },
    traceId: inbound.traceId,
    deadlineAtMs: Date.now() + 60_000,
  });
  const execution = harness.runs.prepareTool({
    runId: run.id,
    call: {
      id: `call_${randomUUID()}`,
      name: toolName,
      argumentsJson: "{}",
    },
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
  harness: WorkspaceHarness,
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
