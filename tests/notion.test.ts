import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { AgentRunStore } from "../src/agent/store.js";
import { ToolRegistry, type ToolExecutionContext } from "../src/agent/tools.js";
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
import {
  NotionMcpError,
  NotionMcpSession,
  type NotionClientProvider,
  type NotionSession,
  type NotionToolDescriptor,
} from "../src/notion/client.js";
import { NotionToolService } from "../src/notion/tools.js";
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

describe("Notion read tools", () => {
  it("routes an explicit workspace, forces internal search, and hides connection IDs", async () => {
    const harness = notionHarness();
    const work = addNotionConnection(harness, "workspace_work", "Work");
    const personal = addNotionConnection(harness, "workspace_personal", "Personal");
    const fixture = sessionFixture(async (name, argumentsValue) => {
      expect(name).toBe("notion-search");
      expect(argumentsValue).toEqual({ query: "quarterly plan", query_type: "internal", page_size: 5 });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              workspace_id: "must-not-cross",
              results: [{ title: "Plan", provider_account_id: "must-not-cross" }],
            }),
          },
          { type: "image", data: "not model-visible" },
        ],
      };
    });
    const provider = fixedSessionProvider(fixture.session);
    const service = notionService(harness, provider);
    const context = toolContext(harness, "notion.search", "read");

    const result = await service.search(
      { query: "quarterly plan", workspace: "Personal", pageSize: 5 },
      context,
    );

    expect(result).toEqual({
      workspace: { label: "Personal" },
      result: { results: [{ title: "Plan" }] },
    });
    expect(provider.selected).toEqual([personal.id]);
    expect(provider.selected).not.toContain(work.id);
    expect(JSON.stringify(result)).not.toContain(personal.id);
    expect(harness.runs.getToolRequired(context.toolExecutionId).connectionId).toBe(personal.id);
  });

  it("normalizes fetch results instead of exposing MCP content blocks", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_fetch", "Docs");
    const fixture = sessionFixture(async (name, argumentsValue) => {
      expect(name).toBe("notion-fetch");
      expect(argumentsValue).toEqual({ id: "page_7" });
      return {
        content: [{ type: "text", text: "A page body" }, { type: "resource_link", uri: "notion://x" }],
      };
    });
    const provider = fixedSessionProvider(fixture.session);
    const service = notionService(harness, provider);

    await expect(
      service.fetch({ id: "page_7" }, toolContext(harness, "notion.fetch", "read")),
    ).resolves.toEqual({
      workspace: { label: "Docs" },
      result: { text: "A page body", truncated: false },
    });
    expect(provider.selected).toEqual([connection.id]);
  });

  it("projects structured fetch responses through an explicit safe field allowlist", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_projection", "Projection");
    const fixture = sessionFixture(async () => ({
      structuredContent: {
        id: "page_8",
        title: "Safe title",
        url: "https://notion.so/page-8",
        content: "Safe body",
        workspace_id: "must-not-cross",
        owner: { id: "must-not-cross" },
      },
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    const result = await service.fetch(
      { id: "page_8" },
      toolContext(harness, "notion.fetch", "read"),
    );

    expect(result).toEqual({
      workspace: { label: "Projection" },
      result: {
        id: "page_8",
        title: "Safe title",
        url: "https://notion.so/page-8",
        text: "Safe body",
        truncated: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
  });
});

describe("Notion writes", () => {
  it("creates exactly one page after recording the durable attempt", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_create", "Projects");
    let calls = 0;
    const fixture = sessionFixture(async (name, argumentsValue) => {
      calls += 1;
      expect(name).toBe("notion-create-pages");
      expect(argumentsValue).toEqual({
        parent: { page_id: "parent_1" },
        pages: [{ properties: { title: "Launch", priority: 2 }, content: "Plan body" }],
      });
      expect(
        harness.database.handle.db
          .prepare<[], { state: string }>("SELECT state FROM write_intents")
          .get()?.state,
      ).toBe("attempting");
      return {
        structuredContent: {
          workspace_id: "must-not-cross",
          pages: [{ id: "created_1", owner: { id: "must-not-cross" } }],
        },
      };
    });
    const provider = fixedSessionProvider(fixture.session);
    const service = notionService(harness, provider);
    const context = toolContext(harness, "notion.create_page", "write");

    const result = await service.createPage(
      {
        workspace: "Projects",
        parent: { type: "page", id: "parent_1" },
        properties: { title: "Launch", priority: 2 },
        content: "Plan body",
      },
      context,
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      ok: true,
      workspace: { label: "Projects" },
      result: { pages: [{ id: "created_1" }] },
    });
    expect(JSON.stringify(result)).not.toContain(connection.id);
    expect(writeStates(harness)).toEqual(["succeeded"]);
    expect(harness.runs.getToolRequired(context.toolExecutionId).status).toBe("succeeded");
  });

  it("maps only the three supported update commands", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_update", "Writing");
    const calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> = [];
    const fixture = sessionFixture(async (name, argumentsValue) => {
      calls.push({ name, argumentsValue });
      return { content: [{ type: "text", text: "updated" }] };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await service.updatePage(
      { pageId: "page_1", command: "update_properties", properties: { status: "Done" } },
      toolContext(harness, "notion.update_page", "write"),
    );
    await service.updatePage(
      { pageId: "page_2", command: "replace_content", newContent: "Replacement" },
      toolContext(harness, "notion.update_page", "write"),
    );
    await service.updatePage(
      {
        pageId: "page_3",
        command: "update_content",
        updates: [{ oldText: "old", newText: "new", replaceAllMatches: true }],
      },
      toolContext(harness, "notion.update_page", "write"),
    );

    expect(calls).toEqual([
      {
        name: "notion-update-page",
        argumentsValue: {
          page_id: "page_1",
          command: "update_properties",
          properties: { status: "Done" },
        },
      },
      {
        name: "notion-update-page",
        argumentsValue: {
          page_id: "page_2",
          command: "replace_content",
          new_str: "Replacement",
        },
      },
      {
        name: "notion-update-page",
        argumentsValue: {
          page_id: "page_3",
          command: "update_content",
          content_updates: [
            { old_str: "old", new_str: "new", replace_all_matches: true },
          ],
        },
      },
    ]);
    expect(writeStates(harness)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("fails closed on upstream schema drift before creating a write intent", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_drift", "Drifted");
    const fixture = sessionFixture(async () => {
      throw new Error("The call must not be dispatched");
    });
    fixture.validate.mockImplementation(() => {
      throw new NotionMcpError("schema_drift", "fixture drift");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.createPage(
        { properties: { title: "Do not create" } },
        toolContext(harness, "notion.create_page", "write"),
      ),
    ).rejects.toMatchObject({ code: "schema_drift" });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it("marks a lost write response ambiguous and never repeats it", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_loss", "Uncertain");
    let calls = 0;
    const fixture = sessionFixture(async () => {
      calls += 1;
      throw new McpError(ErrorCode.RequestTimeout, "response lost");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.createPage(
        { properties: { title: "Maybe created" } },
        toolContext(harness, "notion.create_page", "write"),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    expect(calls).toBe(1);
    expect(writeStates(harness)).toEqual(["ambiguous"]);
  });

  it("treats an MCP error result as acceptance-unknown after dispatch", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_rejected", "Rejected");
    const fixture = sessionFixture(async () => ({
      isError: true,
      content: [{ type: "text", text: "validation failed" }],
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.updatePage(
        { pageId: "page_bad", command: "replace_content", newContent: "Bad" },
        toolContext(harness, "notion.update_page", "write"),
      ),
    ).rejects.toMatchObject({ name: "NotionToolResultError" });
    expect(fixture.call).toHaveBeenCalledTimes(1);
    expect(writeStates(harness)).toEqual(["ambiguous"]);
  });
});

describe("Notion MCP boundary", () => {
  it("live-validates calls without treating compatible additions as unhealthy", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_session", "Session");
    const traceId = newTraceId();
    const client = new Client({ name: "fixture", version: "1.0.0" });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = new Map<string, NotionToolDescriptor>([
      [
        "notion-search",
        {
          name: "notion-search",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              query: { type: "string" },
              query_type: { const: "internal" },
              optional_filter: { type: "string" },
            },
            required: ["query", "query_type"],
            additionalProperties: false,
          },
        },
      ],
    ]);
    const session = new NotionMcpSession({
      client,
      tools,
      traceId,
      connectionId: connection.id,
      traces: harness.traces,
    });

    expect(() => session.validate("notion-search", { query: "x" })).toThrowError(
      expect.objectContaining({ code: "schema_drift" }),
    );
    await session.call("notion-search", { query: "x", query_type: "internal" });

    expect(call).toHaveBeenCalledWith({
      name: "notion-search",
      arguments: { query: "x", query_type: "internal" },
    });
    expect(harness.connections.getRequired(connection.id)).toMatchObject({
      status: "healthy",
      providerState: {},
    });
    const events = harness.traces.list(traceId);
    expect(events.map((event) => [event.component, event.event])).toEqual([
      ["notion_mcp", "tool_attempted"],
      ["notion_mcp", "tool_completed"],
    ]);
    expect(JSON.stringify(events)).not.toContain("query_type");
  });

  it("registers exactly four narrow assistant tools and no destructive operation", () => {
    const harness = notionHarness();
    const fixture = sessionFixture(async () => ({ content: [] }));
    const registry = new ToolRegistry(notionService(harness, fixedSessionProvider(fixture.session)).tools());

    expect(registry.definitions().map((definition) => definition.name)).toEqual([
      "notion.search",
      "notion.fetch",
      "notion.create_page",
      "notion.update_page",
    ]);
    expect(registry.definitions().map((definition) => definition.name).join(" ")).not.toMatch(
      /delete|archive|move|duplicate/u,
    );
  });
});

interface NotionHarness {
  database: TestDatabase;
  traces: TraceStore;
  connections: ConnectionStore;
  router: ConnectionRouter;
  runs: AgentRunStore;
  writes: WriteStore;
  nextSequence: number;
}

function notionHarness(): NotionHarness {
  const database = createTestDatabase();
  databases.push(database);
  const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
  const connections = new ConnectionStore(
    database.handle.db,
    new CredentialVault(Buffer.alloc(32, 23)),
    traces,
  );
  return {
    database,
    traces,
    connections,
    router: new ConnectionRouter(connections),
    runs: new AgentRunStore(database.handle.db, traces),
    writes: new WriteStore(database.handle.db, traces),
    nextSequence: 1,
  };
}

function addNotionConnection(harness: NotionHarness, providerAccountId: string, safeLabel: string) {
  return harness.connections.saveAuthorization({
    traceId: newTraceId(),
    provider: "notion",
    providerAccountId,
    safeLabel,
    safeMetadata: { workspaceName: safeLabel },
    providerState: {
      scopes: ["user", "workspace"],
      toolAccess: ["search", "fetch", "create_pages", "update_page"],
    },
    capabilities: [
      "notion.search",
      "notion.fetch",
      "notion.create_page",
      "notion.update_page",
    ],
    credentials: {
      accessToken: `access-${providerAccountId}`,
      refreshToken: `refresh-${providerAccountId}`,
    },
    expiresAtMs: Date.now() + 3_600_000,
  });
}

function notionService(harness: NotionHarness, clients: NotionClientProvider): NotionToolService {
  return new NotionToolService({
    db: harness.database.handle.db,
    router: harness.router,
    connections: harness.connections,
    clients,
    runs: harness.runs,
    writes: harness.writes,
  });
}

function sessionFixture(
  implementation: (name: string, argumentsValue: Record<string, unknown>) => Promise<unknown>,
): {
  session: NotionSession;
  validate: Mock<NotionSession["validate"]>;
  call: Mock<NotionSession["call"]>;
} {
  const validate = vi.fn<NotionSession["validate"]>();
  const call = vi.fn<NotionSession["call"]>(implementation);
  return { session: { validate, call }, validate, call };
}

function fixedSessionProvider(session: NotionSession): NotionClientProvider & {
  selected: ConnectionId[];
} {
  const selected: ConnectionId[] = [];
  return {
    selected,
    async withSession(connectionId, _traceId, operation) {
      selected.push(connectionId);
      return operation(session);
    },
  };
}

function toolContext(
  harness: NotionHarness,
  toolName: string,
  operationClass: "read" | "write",
  existingRunId?: RunId,
): ToolExecutionContext {
  let runId = existingRunId;
  let traceId: TraceId;
  if (runId === undefined) {
    const inbound = insertInbound(harness, toolName);
    traceId = inbound.traceId;
    const run = harness.runs.startOrResume({ source: { kind: "inbound", inboundId: inbound.inboundId }, traceId, deadlineAtMs: Date.now() + 60_000 });
    runId = run.id;
  } else {
    traceId = harness.runs.getRequired(runId).traceId;
  }
  const execution = harness.runs.prepareTool({
    runId,
    call: { id: `call_${randomUUID()}`, name: toolName, argumentsJson: "{}" },
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
  harness: NotionHarness,
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

function writeStates(harness: NotionHarness): string[] {
  return harness.database.handle.db
    .prepare<[], { state: string }>("SELECT state FROM write_intents ORDER BY created_at_ms, id")
    .all()
    .map((row) => row.state);
}
