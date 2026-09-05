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
              truncated: false,
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
      result: { results: [{ title: "Plan" }], truncated: false },
    });
    expect(provider.selected).toEqual([personal.id]);
    expect(provider.selected).not.toContain(work.id);
    expect(JSON.stringify(result)).not.toContain(personal.id);
    expect(harness.runs.getToolRequired(context.toolExecutionId).connectionId).toBe(personal.id);
  });

  it("preserves structured search truncation metadata", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_search_truncated", "Search");
    const fixture = sessionFixture(async () => ({
      structuredContent: {
        results: [{ id: "page_1", title: "Plan" }],
        truncated: true,
      },
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.search(
        { query: "plan", workspace: "Search", pageSize: 5 },
        toolContext(harness, "notion.search", "read"),
      ),
    ).resolves.toEqual({
      workspace: { label: "Search" },
      result: {
        results: [{ id: "page_1", title: "Plan" }],
        truncated: true,
      },
    });
  });

  it("treats an omitted search truncation marker as complete below the requested limit", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_search_complete", "Search");
    const fixture = sessionFixture(async () => ({
      structuredContent: {
        results: [{ id: "page_1", title: "Plan" }],
      },
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.search(
        { query: "quarterly", workspace: "Search", pageSize: 5 },
        toolContext(harness, "notion.search", "read"),
      ),
    ).resolves.toEqual({
      workspace: { label: "Search" },
      result: {
        results: [{ id: "page_1", title: "Plan" }],
        truncated: false,
      },
    });
  });

  it("honors an explicit complete search at the requested result limit", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_search_exact_limit", "Search");
    const fixture = sessionFixture(async () => ({
      structuredContent: {
        results: [{ id: "page_1", title: "Plan" }],
        truncated: false,
      },
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.search(
        { query: "plan", workspace: "Search", pageSize: 1 },
        toolContext(harness, "notion.search", "read"),
      ),
    ).resolves.toEqual({
      workspace: { label: "Search" },
      result: {
        results: [{ id: "page_1", title: "Plan" }],
        truncated: false,
      },
    });
    expect(fixture.call).toHaveBeenCalledTimes(1);
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
        truncated: true,
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
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
  });

  it("treats an omitted fetch truncation marker as complete without omitted blocks", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_complete", "Complete");
    const fixture = sessionFixture(async () => ({
      structuredContent: {
        id: "page_complete",
        content: "Complete body",
      },
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.fetch(
        { id: "page_complete" },
        toolContext(harness, "notion.fetch", "read"),
      ),
    ).resolves.toEqual({
      workspace: { label: "Complete" },
      result: {
        id: "page_complete",
        text: "Complete body",
        truncated: false,
      },
    });
  });

  it("rejects malformed truncation metadata in JSON text results", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_malformed", "Malformed");
    const fixture = sessionFixture(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "page_malformed",
            content: "Untrusted completeness",
            truncated: "false",
          }),
        },
      ],
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(
      service.fetch(
        { id: "page_malformed" },
        toolContext(harness, "notion.fetch", "read"),
      ),
    ).rejects.toBeDefined();
  });

  it("treats reported omitted fetch subtrees as truncated", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_incomplete", "Incomplete");
    const fixture = sessionFixture(async () => ({
      structuredContent: {
        id: "page_incomplete",
        content: "Possibly incomplete body",
        unknown_block_ids: ["block_omitted"],
        unknown_block_count: 1,
      },
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    const result = await service.fetch(
      { id: "page_incomplete" },
      toolContext(harness, "notion.fetch", "read"),
    );

    expect(result).toEqual({
      workspace: { label: "Incomplete" },
      result: {
        id: "page_incomplete",
        text: "Possibly incomplete body",
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("block_omitted");
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
      outcome: "succeeded",
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              object: "page_markdown",
              id: argumentsValue.page_id,
              truncated: false,
            }),
          },
        ],
      };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await service.updatePage(
      { pageId: "page_1", command: "update_properties", properties: { status: "Done" } },
      fetchedUpdateContext(harness, "page_1", "old"),
    );
    await service.updatePage(
      { pageId: "page_2", command: "replace_content", newContent: "Replacement" },
      fetchedUpdateContext(harness, "page_2", "old"),
    );
    await service.updatePage(
      {
        pageId: "page_3",
        command: "update_content",
        updates: [{ oldText: "old", newText: "new", replaceAllMatches: false }],
      },
      fetchedUpdateContext(harness, "page_3", "old"),
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
            { old_str: "old", new_str: "new", replace_all_matches: false },
          ],
        },
      },
    ]);
    expect(writeStates(harness)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("names a stray field on an update instead of failing at the provider boundary", async () => {
    // Production shape: the model sent newContent alongside update_content. The registry
    // must reject it by path before any intent or dispatch, so the model corrects its call.
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_stray", "Stray");
    const fixture = sessionFixture(async () => { throw new Error("must not dispatch"); });
    const registry = new ToolRegistry(notionService(harness, fixedSessionProvider(fixture.session)).tools());

    await expect(registry.execute({
      name: "notion.update_page",
      argumentsJson: JSON.stringify({
        workspace: "Stray", pageId: "page_1", command: "update_content", newContent: "",
        updates: [{ oldText: "- [ ] Task", newText: "- [x] Task" }],
      }),
      context: toolContext(harness, "notion.update_page", "write"),
    })).rejects.toMatchObject({
      code: "invalid_arguments",
      message: expect.stringMatching(/newContent/u),
    });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it("rejects an incompatible write before intent or MCP dispatch without changing health", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_drift", "Drifted");
    const context = toolContext(harness, "notion.create_page", "write");
    const client = new Client({ name: "fixture", version: "1.0.0" });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "must not be returned" }],
    });
    const session = new NotionMcpSession({
      client,
      tools: new Map<string, NotionToolDescriptor>([
        [
          "notion-create-pages",
          {
            name: "notion-create-pages",
            inputSchema: {
              type: "object",
              properties: {
                pages: { type: "array" },
                new_required_guard: { type: "string" },
              },
              required: ["pages", "new_required_guard"],
              additionalProperties: false,
            },
          },
        ],
      ]),
      traceId: context.traceId,
      connectionId: connection.id,
      traces: harness.traces,
    });
    const service = notionService(harness, fixedSessionProvider(session));
    const healthBefore = harness.connections.getRequired(connection.id);

    await expect(
      service.createPage(
        { properties: { title: "Do not create" } },
        context,
      ),
    ).rejects.toMatchObject({ code: "schema_drift" });

    expect(call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
    expect(harness.connections.getRequired(connection.id)).toMatchObject({
      status: "healthy",
      healthGeneration: healthBefore.healthGeneration,
      lastErrorCode: null,
    });
    expect(
      harness.traces
        .list(context.traceId)
        .filter((event) => event.component === "notion_mcp"),
    ).toEqual([]);
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
      content: [{ type: "text", text: "private-provider-body-never-log" }],
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const context = fetchedUpdateContext(harness, "page_bad", "Original");

    await expect(
      service.updatePage(
        { pageId: "page_bad", command: "replace_content", newContent: "Bad" },
        context,
      ),
    ).rejects.toMatchObject({ name: "NotionToolResultError" });
    expect(fixture.call).toHaveBeenCalledTimes(1);
    expect(writeStates(harness)).toEqual(["ambiguous"]);
    expect(harness.runs.getToolRequired(context.toolExecutionId).result).toMatchObject({
      error: { code: "acceptance_unknown" },
    });
    expect(JSON.stringify(harness.traces.list(context.traceId))).not.toContain(
      "private-provider-body-never-log",
    );
  });
  it.each([
    { label: "a page view", response: { structuredContent: { object: "page_markdown", id: "page_ack", markdown: "x", truncated: true, unknown_block_ids: ["b"] } } },
    { label: "a bare text body", response: { content: [{ type: "text", text: "updated" }] } },
  ])("treats $label from a non-error update as accepted", async ({ response }) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_ack", "Acknowledged");
    const fixture = sessionFixture(async () => response);
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const context = fetchedUpdateContext(harness, "page_ack", "original");

    await expect(service.updatePage(
      {
        pageId: "page_ack", command: "update_content",
        updates: [{ oldText: "original", newText: "replacement", replaceAllMatches: false }],
      },
      context,
    )).resolves.toMatchObject({
      ok: true, outcome: "succeeded", result: { pageId: "page_ack", updated: true },
    });
    expect(writeStates(harness)).toEqual(["succeeded"]);
    expect(fixture.call).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "a rendered page body", response: { content: [{ type: "text", text: "<page url=\"https://notion.so/x\">\n# logit notes\n</page>" }] }, pages: [] },
    { label: "a documented pages receipt", response: { content: [{ type: "text", text: "{\"pages\":[{\"id\":\"created_2\",\"url\":\"https://notion.so/created_2\",\"properties\":{\"title\":\"logit notes\"}}]}" }] }, pages: [{ id: "created_2", url: "https://notion.so/created_2" }] },
  ])("treats $label from a non-error create as accepted", async ({ response, pages }) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_create_ack", "Notes");
    const fixture = sessionFixture(async () => response);
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(service.createPage(
      { workspace: "Notes", properties: { title: "logit notes" } },
      toolContext(harness, "notion.create_page", "write"),
    )).resolves.toMatchObject({ ok: true, outcome: "succeeded", result: { pages } });
    expect(writeStates(harness)).toEqual(["succeeded"]);
    expect(fixture.call).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued async create acceptance-unknown", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_create_async", "Notes");
    const fixture = sessionFixture(async () => ({
      structuredContent: { object: "async_task", id: "t1", status: "queued" },
    }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(service.createPage(
      { workspace: "Notes", properties: { title: "logit notes" } },
      toolContext(harness, "notion.create_page", "write"),
    )).rejects.toBeDefined();
    expect(writeStates(harness)).toEqual(["ambiguous"]);
  });

  it.each([
    { label: "a queued async task", response: { structuredContent: { object: "async_task", id: "t1", status: "queued" } } },
    { label: "a wrapped async task", response: { structuredContent: { page_id: "page_ack", async_task: { id: "t1" } } } },
    { label: "a running task on the page", response: { structuredContent: { page_id: "page_ack", status: "running" } } },
    { label: "an error field", response: { structuredContent: { page_id: "page_ack", error: { code: "validation_error" } } } },
    { label: "an empty envelope", response: {} },
  ])("keeps $label acceptance-unknown", async ({ response }) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_async", "Async");
    const fixture = sessionFixture(async () => response);
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(service.updatePage(
      {
        pageId: "page_ack", command: "update_content",
        updates: [{ oldText: "original", newText: "replacement", replaceAllMatches: false }],
      },
      fetchedUpdateContext(harness, "page_ack", "original"),
    )).rejects.toBeDefined();
    expect(writeStates(harness)).toEqual(["ambiguous"]);
    expect(fixture.call).toHaveBeenCalledTimes(1);
  });

  it("returns an authoritative unchanged result without preparing or sending a write", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_noop", "Work");
    const fixture = sessionFixture(async () => {
      throw new Error("An unchanged patch must not contact Notion");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const text = "## Yesterday\n- [x] Clean and organize room";
    const context = fetchedUpdateContext(harness, "tasks", text);

    await expect(service.updatePage({
      workspace: "Work",
      pageId: "tasks",
      command: "update_content",
      updates: [{ oldText: text, newText: text, replaceAllMatches: false }],
    }, context)).resolves.toEqual({
      ok: true,
      outcome: "unchanged",
      workspace: { label: "Work" },
      result: { pageId: "tasks" },
    });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it.each([
    { label: "absent source", text: "- [ ] Different task" },
    { label: "repeated source", text: "- [ ] Task\n- [ ] Task" },
  ])("rejects $label without dispatching a patch", async ({ text }) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_source", "Work");
    const fixture = sessionFixture(async () => {
      throw new Error("Unproved patch reached the provider");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(service.updatePage({
      pageId: "tasks",
      command: "update_content",
      updates: [{ oldText: "- [ ] Task", newText: "- [x] Task", replaceAllMatches: false }],
    }, fetchedUpdateContext(harness, "tasks", text))).rejects.toMatchObject({
      code: "write_target_ambiguous",
    });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it.each([
    { label: "another page", sourcePage: "other", truncated: false, freshRun: false },
    { label: "an incomplete fetch", sourcePage: "tasks", truncated: true, freshRun: false },
    { label: "a previous run", sourcePage: "tasks", truncated: false, freshRun: true },
  ])("does not use $label to authorize an update", async ({ sourcePage, truncated, freshRun }) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_proof", "Work");
    const fixture = sessionFixture(async () => {
      throw new Error("Unproved target reached the provider");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const sourceContext = fetchedUpdateContext(harness, sourcePage, "original", { truncated });
    const context = freshRun
      ? toolContext(harness, "notion.update_page", "write")
      : sourceContext;

    await expect(service.updatePage({
      pageId: "tasks",
      command: "replace_content",
      newContent: "replacement",
    }, context)).rejects.toMatchObject({ code: "write_target_unverified" });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it("cannot edit a second account using the first account's fetched page", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_work_proof", "Work");
    addNotionConnection(harness, "workspace_personal_proof", "Personal");
    const fixture = sessionFixture(async () => {
      throw new Error("Cross-account target reached the provider");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const context = fetchedUpdateContext(harness, "shared_id", "original", { workspace: "Work" });

    await expect(service.updatePage({
      workspace: "Personal",
      pageId: "shared_id",
      command: "replace_content",
      newContent: "replacement",
    }, context)).rejects.toMatchObject({ code: "write_target_unverified" });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it("does not fall back to an older complete fetch after a newer incomplete result", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_latest", "Work");
    const fixture = sessionFixture(async () => {
      throw new Error("An older snapshot reached the provider");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const context = fetchedUpdateContext(harness, "tasks", "original");
    const newer = toolContext(harness, "notion.fetch", "read", context.runId, { id: "tasks" });
    harness.runs.bindToolConnection(newer.toolExecutionId, connection.id);
    harness.runs.finishTool(newer.toolExecutionId, "succeeded", {
      workspace: { label: "Work" },
      result: { text: "partial newer content", truncated: true },
    });

    await expect(service.updatePage({
      workspace: "Work",
      pageId: "tasks",
      command: "replace_content",
      newContent: "replacement",
    }, context)).rejects.toMatchObject({ code: "write_target_unverified" });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });
});

describe("Notion MCP boundary", () => {
  it("accepts an additive optional read field and keeps the connection healthy", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_session", "Session");
    const context = toolContext(harness, "notion.search", "read");
    const client = new Client({ name: "fixture", version: "1.0.0" });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({
      structuredContent: { results: [], truncated: false },
      content: [],
    });
    const session = new NotionMcpSession({
      client,
      tools: new Map<string, NotionToolDescriptor>([
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
                page_size: { type: "integer" },
                optional_filter: { type: "string" },
              },
              required: ["query", "query_type"],
              additionalProperties: false,
            },
          },
        ],
      ]),
      traceId: context.traceId,
      connectionId: connection.id,
      traces: harness.traces,
    });
    const service = notionService(harness, fixedSessionProvider(session));
    const healthBefore = harness.connections.getRequired(connection.id);

    await expect(service.search({ query: "x", pageSize: 1 }, context)).resolves.toEqual({
      workspace: { label: "Session" },
      result: { results: [], truncated: false },
    });

    expect(call).toHaveBeenCalledWith({
      name: "notion-search",
      arguments: { query: "x", query_type: "internal", page_size: 1 },
    });
    expect(harness.connections.getRequired(connection.id)).toMatchObject({
      status: "healthy",
      healthGeneration: healthBefore.healthGeneration,
      lastErrorCode: null,
    });
    expect(
      harness.traces
        .list(context.traceId)
        .filter((event) => event.component === "notion_mcp")
        .map((event) => event.event),
    ).toEqual(["tool_attempted", "tool_completed"]);
  });

  it("fails only an incompatible read call and keeps the connection healthy", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_incompatible", "Incompatible");
    const context = toolContext(harness, "notion.search", "read");
    const client = new Client({ name: "fixture", version: "1.0.0" });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({
      structuredContent: { results: [] },
      content: [],
    });
    const session = new NotionMcpSession({
      client,
      tools: new Map<string, NotionToolDescriptor>([
        [
          "notion-search",
          {
            name: "notion-search",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                query_type: { const: "internal" },
                page_size: { type: "integer" },
                new_required_filter: { type: "string" },
              },
              required: ["query", "query_type", "new_required_filter"],
              additionalProperties: false,
            },
          },
        ],
      ]),
      traceId: context.traceId,
      connectionId: connection.id,
      traces: harness.traces,
    });
    const service = notionService(harness, fixedSessionProvider(session));
    const healthBefore = harness.connections.getRequired(connection.id);

    await expect(service.search({ query: "x", pageSize: 1 }, context)).rejects.toMatchObject({
      code: "schema_drift",
    });

    expect(call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
    expect(harness.connections.getRequired(connection.id)).toMatchObject({
      status: "healthy",
      healthGeneration: healthBefore.healthGeneration,
      lastErrorCode: null,
    });
    expect(
      harness.traces
        .list(context.traceId)
        .filter((event) => event.component === "notion_mcp"),
    ).toEqual([]);
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
  argumentsValue: Record<string, unknown> = {},
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
    call: {
      id: `call_${randomUUID()}`,
      name: toolName,
      argumentsJson: JSON.stringify(argumentsValue),
    },
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

function fetchedUpdateContext(
  harness: NotionHarness,
  pageId: string,
  text: string,
  options: { workspace?: string; truncated?: boolean } = {},
): ToolExecutionContext {
  const connection = harness.router.select({
    capabilities: ["notion.fetch"],
    ...(options.workspace === undefined ? {} : { account: options.workspace }),
  });
  const fetched = toolContext(harness, "notion.fetch", "read", undefined, {
    id: pageId,
    workspace: connection.safeLabel,
  });
  harness.runs.bindToolConnection(fetched.toolExecutionId, connection.id);
  harness.runs.finishTool(fetched.toolExecutionId, "succeeded", {
    workspace: { label: connection.safeLabel },
    result: { text, truncated: options.truncated ?? false },
  });
  return toolContext(harness, "notion.update_page", "write", fetched.runId);
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
