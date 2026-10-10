import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { z } from "zod";
import { AgentRunStore } from "../src/agent/store.js";
import { ToolRegistry, type ToolExecutionContext } from "../src/agent/tools.js";
import { loadRuntimeConfig } from "../src/config.js";
import { RefreshCoordinator } from "../src/connections/refresh.js";
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
  HostedNotionClientProvider,
  NotionMcpSession,
  type NotionClientProvider,
  type NotionSession,
  type NotionToolDescriptor,
} from "../src/notion/client.js";
import type { TaskChange } from "../src/notion/tasks.js";
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

    const result = await service.search({ query: "quarterly plan", workspace: "Personal", pageSize: 5, hydrate: 0 }, context);

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
      service.search({ query: "plan", workspace: "Search", pageSize: 5, hydrate: 0 }, toolContext(harness, "notion.search", "read")),
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
      service.search({ query: "quarterly", workspace: "Search", pageSize: 5, hydrate: 0 }, toolContext(harness, "notion.search", "read")),
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
      service.search({ query: "plan", workspace: "Search", pageSize: 1, hydrate: 0 }, toolContext(harness, "notion.search", "read")),
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

  it("maps the three general update commands to their provider commands", async () => {
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
    { label: "absent source", text: "- [ ] Different task", code: "write_target_not_found" },
    { label: "repeated source", text: "- [ ] Task\n- [ ] Task", code: "write_target_ambiguous" },
  ])("rejects $label without dispatching a patch", async ({ text, code }) => {
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
      code,
    });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it.each([
    { label: "authorizes", truncated: false, code: undefined },
    { label: "does not authorize with an incomplete page", truncated: true, code: "write_target_unverified" },
  ])("a hydrated search result $label an update like a fetch", async ({ truncated, code }) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_hydrate", "Work");
    const calls: string[] = [];
    const fixture = sessionFixture(async (name, argumentsValue) => {
      calls.push(name);
      if (name === "notion-search") {
        return { structuredContent: { results: [{ id: "tasks", title: "Tasks" }, { id: "notes", title: "Notes" }], truncated: false } };
      }
      if (name === "notion-fetch") {
        return { structuredContent: { id: String(argumentsValue.id), text: "- [ ] Task\n- [ ] Other", truncated } };
      }
      return { structuredContent: { id: "tasks" } };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const searchContext = toolContext(harness, "notion.search", "read", undefined, { query: "task", hydrate: 1 });

    const searched = await service.search({ query: "task", workspace: "Work", pageSize: 5, hydrate: 1 }, searchContext);
    harness.runs.finishTool(searchContext.toolExecutionId, "succeeded", searched);

    // One hydrated page in one tool round: the search plus exactly one fetch, both in the
    // same session, and the page carries the fetch shape the guard checks.
    expect(calls).toEqual(["notion-search", "notion-fetch"]);
    expect(searched).toMatchObject({ result: { pages: [{ id: "tasks", text: "- [ ] Task\n- [ ] Other", truncated }] } });

    const update = service.updatePage({
      pageId: "tasks", command: "update_content",
      updates: [{ oldText: "- [ ] Task", newText: "- [x] Task", replaceAllMatches: false }],
    }, toolContext(harness, "notion.update_page", "write", searchContext.runId));
    if (code === undefined) {
      await expect(update).resolves.toMatchObject({ ok: true, outcome: "succeeded" });
      expect(writeStates(harness)).toEqual(["succeeded"]);
    } else {
      await expect(update).rejects.toMatchObject({ code });
      expect(writeStates(harness)).toEqual([]);
    }
  });

  it("keeps the search result when a hydration fetch fails", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_hydrate_fail", "Work");
    const fixture = sessionFixture(async (name) => {
      if (name === "notion-search") {
        return { structuredContent: { results: [{ id: "broken", title: "Broken" }], truncated: false } };
      }
      return { isError: true, content: [{ type: "text", text: "boom" }] };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));

    await expect(service.search(
      { query: "broken", workspace: "Work", pageSize: 5, hydrate: 1 },
      toolContext(harness, "notion.search", "read"),
    )).resolves.toMatchObject({ result: { results: [{ id: "broken" }], pages: [] } });
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

describe("Notion task edits", () => {
  it.each(["fetch", "search"])("uses a compact %s read as complete same-run proof without exposing the full source", async (readKind) => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_compact", "Tasks");
    const source = "# Tasks\nPrivate prose that must stay out of the task view.\n## Yesterday\n- [ ] Repeat\n## Today\n- [ ] Repeat\n";
    const fixture = sessionFixture(async (name, argumentsValue) => {
      if (name === "notion-search") {
        return { structuredContent: { results: [{ id: "tasks", title: "Tasks", highlight: source }], truncated: false } };
      }
      if (name === "notion-fetch") {
        return { structuredContent: { id: "tasks", text: source, truncated: false } };
      }
      expect(name).toBe("notion-update-page");
      expect(writeStates(harness)).toEqual(["attempting"]);
      const updates = providerTaskPatchSchema.parse(argumentsValue.content_updates);
      expect(argumentsValue.command).toBe("update_content");
      expect(updates[0].replace_all_matches).toBe(false);
      expect(source.split(updates[0].old_str)).toHaveLength(2);
      return { content: [{ type: "text", text: "accepted" }] };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const readArguments = readKind === "search"
      ? { query: "Tasks", workspace: "Tasks", hydrate: 1, view: "tasks" }
      : { id: "tasks", workspace: "Tasks", view: "tasks" };
    const context = toolContext(harness, `notion.${readKind}`, "read", undefined, readArguments);
    const result = readKind === "search"
      ? await service.search({ query: "Tasks", workspace: "Tasks", pageSize: 5, hydrate: 1, view: "tasks" }, context)
      : await service.fetch({ id: "tasks", workspace: "Tasks", view: "tasks" }, context);
    harness.runs.finishTool(context.toolExecutionId, "succeeded", result);
    const envelope = compactReadEnvelopeSchema.parse(result);
    const page = readKind === "search"
      ? compactSearchEnvelopeSchema.parse(result).result.pages[0]
      : compactTaskPageSchema.parse(envelope.result);
    assert(page !== undefined);
    const section = page.sections.find((value) => value.path.at(-1) === "Today");
    assert(section !== undefined);
    const task = section.tasks[0];
    assert(task !== undefined);
    expect(JSON.stringify(envelope.result)).not.toContain("Private prose");
    expect(JSON.stringify(envelope.result)).not.toContain(connection.id);
    expect(JSON.stringify(envelope.result)).not.toContain(context.runId);
    expect(task.ref).toMatch(/^t_[a-f0-9]{24,}$/u);
    expect(section.ref).toMatch(/^s_[a-f0-9]{24,}$/u);
    expect(result).toMatchObject(readKind === "search" ? { hidden: { pages: [{ text: source }] } } : { hidden: { page: { text: source } } });

    const changed = await service.updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks",
      changes: [
        { kind: "check", task: task.ref, checked: true },
        { kind: "append", section: section.ref, text: "Repeat" },
      ],
    }, toolContext(harness, "notion.update_page", "write", context.runId));
    expect(changed).toMatchObject({
      outcome: "succeeded",
      result: { pageId: "tasks", view: "tasks", ordering: "changed_sections" },
      hidden: { page: { id: "tasks", text: source.replace("## Today\n- [ ] Repeat\n", "## Today\n- [x] Repeat\n- [ ] Repeat\n"), truncated: false } },
    });
    expect(writeStates(harness)).toEqual(["succeeded"]);
    expect(fixture.call.mock.calls.filter(([name]) => name === "notion-update-page")).toHaveLength(1);
  });

  it.each([
    { name: "notion.search", argumentsValue: { query: "tasks", view: "tasks", hydrate: 0 } },
    { name: "notion.search", argumentsValue: { query: "tasks", view: "tasks" } },
    { name: "notion.search", argumentsValue: { query: "tasks", hydrate: 1, match: "older" } },
    { name: "notion.fetch", argumentsValue: { id: "tasks", view: "full", match: "older" } },
    { name: "notion.fetch", argumentsValue: { id: "tasks", match: "older" } },
    { name: "notion.fetch", argumentsValue: { id: "tasks", view: "tasks", match: "first\nsecond" } },
    { name: "notion.fetch", argumentsValue: { id: "tasks", view: "tasks", match: "x".repeat(513) } },
  ])("rejects invalid compact read options before calling the provider: $argumentsValue", async ({ name, argumentsValue }) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_invalid_read", "Tasks");
    const fixture = sessionFixture(async () => { throw new Error("invalid read dispatched"); });
    const registry = new ToolRegistry(notionService(harness, fixedSessionProvider(fixture.session)).tools());
    await expect(registry.execute({
      name, argumentsJson: JSON.stringify(argumentsValue), context: toolContext(harness, name, "read"),
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it.each([
    { changes: [] },
    { changes: Array.from({ length: 17 }, () => ({ kind: "append", section: "s_unknown", text: "Task" })) },
    { changes: [{ kind: "append", section: "s_unknown", text: "line\nline" }] },
    { changes: [{ kind: "append", section: "s_unknown", text: " ".repeat(2) }] },
    { changes: [{ kind: "append", section: "s_unknown", text: "x".repeat(2_001) }] },
    { changes: [{ kind: "append", section: "s_unknown", text: "Task", checked: true }] },
    { changes: [{ kind: "check", task: "t_unknown", checked: "true" }] },
    { changes: [{ kind: "check", task: "t_unknown", checked: true, text: "Task" }] },
    { changes: [{ kind: "check", task: "t_unknown", checked: true }], newContent: "forbidden" },
    { changes: [{ kind: "check", task: "t_unknown", checked: true }], updates: [{ oldText: "x", newText: "y" }] },
    { changes: [{ kind: "check", task: "t_unknown", checked: true }], properties: { title: "forbidden" } },
  ])("rejects malformed task commands before source lookup or intent: $changes", async (fields) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_invalid_task", "Tasks");
    const fixture = sessionFixture(async () => { throw new Error("invalid task command dispatched"); });
    const registry = new ToolRegistry(notionService(harness, fixedSessionProvider(fixture.session)).tools());
    await expect(registry.execute({
      name: "notion.update_page",
      argumentsJson: JSON.stringify({ workspace: "Tasks", pageId: "tasks", command: "edit_tasks", ...fields }),
      context: toolContext(harness, "notion.update_page", "write"),
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(fixture.validate).not.toHaveBeenCalled();
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it.each([
    { command: "update_properties", properties: { title: "Title" } },
    { command: "replace_content", newContent: "Text" },
    { command: "update_content", updates: [{ oldText: "old", newText: "new" }] },
  ])("forbids task changes on the general $command command before intent", async (fields) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_general_fields", "Tasks");
    const fixture = sessionFixture(async () => { throw new Error("stray changes dispatched"); });
    const registry = new ToolRegistry(notionService(harness, fixedSessionProvider(fixture.session)).tools());
    await expect(registry.execute({
      name: "notion.update_page",
      argumentsJson: JSON.stringify({
        workspace: "Tasks", pageId: "tasks", ...fields,
        changes: [{ kind: "append", section: "s_unknown", text: "Task" }],
      }),
      context: toolContext(harness, "notion.update_page", "write"),
    })).rejects.toMatchObject({ code: "invalid_arguments", message: expect.stringMatching(/changes/u) });
    expect(fixture.call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it.each(["unknown", "wrong run", "wrong page", "wrong connection", "credential generation", "changed source"])("rejects %s refs before intent", async (scenario) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_ref", "Tasks");
    let source = "## Today\n- [ ] Original\n";
    const fixture = sessionFixture(async (name, argumentsValue) => {
      expect(name).toBe("notion-fetch");
      return { structuredContent: { id: String(argumentsValue.id), text: source, truncated: false } };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const first = await compactFetch(harness, service, "tasks");
    const task = first.page.sections.flatMap((section) => section.tasks)[0];
    assert(task !== undefined);
    let runId = first.context.runId;
    let pageId = "tasks";
    let workspace = "Tasks";
    if (scenario === "wrong run") {
      runId = (await compactFetch(harness, service, "tasks")).context.runId;
    } else if (scenario === "wrong page") {
      pageId = "other";
      await compactFetch(harness, service, pageId, runId);
    } else if (scenario === "wrong connection") {
      addNotionConnection(harness, "workspace_ref_other", "Other");
      workspace = "Other";
      await compactFetch(harness, service, pageId, runId, workspace);
    } else if (scenario === "credential generation") {
      addNotionConnection(harness, "workspace_ref", "Tasks");
      await compactFetch(harness, service, pageId, runId);
    } else if (scenario === "changed source") {
      source += "An unrelated new line changes the source hash.\n";
      await compactFetch(harness, service, pageId, runId);
    }
    await expect(service.updatePage({
      workspace, pageId, command: "edit_tasks",
      changes: [{ kind: "check", task: scenario === "unknown" ? "t_unknown" : task.ref, checked: true }],
    }, toolContext(harness, "notion.update_page", "write", runId))).rejects.toMatchObject({ code: "task_ref_invalid" });
    expect(fixture.validate).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
    expect(fixture.call.mock.calls.every(([name]) => name === "notion-fetch")).toBe(true);
  });

  it.each(["fetch", "search"])("blocks an older complete task proof after a newer incomplete compact %s", async (readKind) => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_truncated_task", "Tasks");
    let truncated = false;
    const fixture = sessionFixture(async (name) => name === "notion-search"
      ? { structuredContent: { results: [{ id: "tasks" }], truncated: false } }
      : { structuredContent: { id: "tasks", text: "## Today\n- [ ] Original\n", truncated } });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const first = await compactFetch(harness, service, "tasks");
    const task = first.page.sections.flatMap((section) => section.tasks)[0];
    assert(task !== undefined);
    truncated = true;
    const context = toolContext(harness, `notion.${readKind}`, "read", first.context.runId, { id: "tasks", view: "tasks" });
    const result = readKind === "search"
      ? await service.search({ query: "Tasks", workspace: "Tasks", pageSize: 5, hydrate: 1, view: "tasks" }, context)
      : await service.fetch({ id: "tasks", workspace: "Tasks", view: "tasks" }, context);
    harness.runs.finishTool(context.toolExecutionId, "succeeded", result);
    const visible = compactReadEnvelopeSchema.parse(result).result;
    expect(visible).toMatchObject(readKind === "search"
      ? { pages: [{ view: "tasks", sourceComplete: false, available: false }] }
      : { view: "tasks", sourceComplete: false, available: false });
    expect(JSON.stringify(visible)).not.toContain(task.ref);
    await expect(service.updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "check", task: task.ref, checked: true }],
    }, toolContext(harness, "notion.update_page", "write", first.context.runId))).rejects.toMatchObject({ code: "write_target_unverified" });
    expect(writeStates(harness)).toEqual([]);
    expect(fixture.call.mock.calls.some(([name]) => name === "notion-update-page")).toBe(false);
  });

  it.each(["full", "tasks"].flatMap((view) => ["failed", "wrong identity", "page limit", "aggregate limit"].map((failure) => ({ view, failure }))))(
    "blocks stale task refs after $failure hydration in $view mode without blocking other hydrated pages",
    async ({ view, failure }) => {
      const harness = notionHarness();
      addNotionConnection(harness, "workspace_failed_hydration", "Tasks");
      const source = "## Today\n- [ ] Original\n";
      let newer = false;
      const fixture = sessionFixture(async (name, argumentsValue) => {
        if (name === "notion-search") {
          const ids = failure === "aggregate limit" ? ["first", "second", "tasks"] : ["tasks"];
          return { structuredContent: { results: ids.map((id) => ({ id })), truncated: false } };
        }
        if (name === "notion-fetch") {
          if (newer && failure === "failed") return { isError: true, content: [{ type: "text", text: "unavailable" }] };
          if (newer && failure === "wrong identity") return { structuredContent: { id: "other", text: source, truncated: false } };
          const padding = !newer ? "" : "x".repeat(failure === "page limit" ? 26_000 : 18_000);
          return { structuredContent: { id: String(argumentsValue.id), text: source + padding, truncated: false } };
        }
        return { content: [{ type: "text", text: "accepted" }] };
      });
      const service = notionService(harness, fixedSessionProvider(fixture.session));
      const first = await compactFetch(harness, service, "tasks");
      const task = first.page.sections.flatMap((section) => section.tasks)[0];
      assert(task !== undefined);
      newer = true;
      const hydrate = failure === "aggregate limit" ? 3 : 1;
      const argumentsValue = { query: "Tasks", workspace: "Tasks", pageSize: 5, hydrate, view: view as "full" | "tasks" };
      const context = toolContext(harness, "notion.search", "read", first.context.runId, argumentsValue);
      const result = await service.search(argumentsValue, context);
      harness.runs.finishTool(context.toolExecutionId, "succeeded", result);
      await expect(service.updatePage({
        workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "check", task: task.ref, checked: true }],
      }, toolContext(harness, "notion.update_page", "write", first.context.runId))).rejects.toMatchObject({ code: "write_target_unverified" });
      expect(writeStates(harness)).toEqual([]);
      expect(fixture.validate).not.toHaveBeenCalled();
      expect(fixture.call.mock.calls.some(([name]) => name === "notion-update-page")).toBe(false);
      if (failure === "aggregate limit") {
        await expect(service.updatePage({
          workspace: "Tasks", pageId: "first", command: "update_content",
          updates: [{ oldText: "- [ ] Original", newText: "- [x] Original", replaceAllMatches: false }],
        }, toolContext(harness, "notion.update_page", "write", first.context.runId))).resolves.toMatchObject({ outcome: "succeeded" });
      }
      newer = false;
      const refreshed = await compactFetch(harness, service, "tasks", first.context.runId);
      const currentTask = refreshed.page.sections.flatMap((section) => section.tasks)[0];
      assert(currentTask !== undefined);
      await expect(service.updatePage({
        workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "check", task: currentTask.ref, checked: true }],
      }, toolContext(harness, "notion.update_page", "write", first.context.runId))).resolves.toMatchObject({ outcome: "succeeded" });
    },
  );

  it("returns authoritative refreshed task refs for a no-op without preparing or dispatching", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_noop", "Tasks");
    const source = "## Today\n- [x] Already done\n";
    const fixture = sessionFixture(async (name) => {
      expect(name).toBe("notion-fetch");
      return { structuredContent: { id: "tasks", text: source, truncated: false } };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const read = await compactFetch(harness, service, "tasks");
    const task = read.page.sections.flatMap((section) => section.tasks)[0];
    assert(task !== undefined);
    const result = await service.updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "check", task: task.ref, checked: true }],
    }, toolContext(harness, "notion.update_page", "write", read.context.runId));
    expect(result).toMatchObject({
      outcome: "unchanged",
      result: { view: "tasks", sections: [{ tasks: [{ ref: task.ref, checked: true }] }] },
      hidden: { page: { id: "tasks", text: source, truncated: false } },
    });
    expect(writeStates(harness)).toEqual([]);
    expect(fixture.validate).not.toHaveBeenCalled();
    expect(fixture.call).toHaveBeenCalledTimes(1);
  });

  it("validates the generated provider patch against the live schema before preparing intent", async () => {
    const harness = notionHarness();
    const connection = addNotionConnection(harness, "workspace_task_drift", "Tasks");
    const fixture = sessionFixture(async () => ({ structuredContent: { id: "tasks", text: "## Today\n- [ ] Original\n", truncated: false } }));
    const read = await compactFetch(harness, notionService(harness, fixedSessionProvider(fixture.session)), "tasks");
    const section = read.page.sections[0];
    assert(section !== undefined);
    const context = toolContext(harness, "notion.update_page", "write", read.context.runId);
    const client = new Client({ name: "fixture", version: "1.0.0" });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({ content: [{ type: "text", text: "must not return" }] });
    const tools: Record<string, NotionToolDescriptor> = {
      "notion-update-page": {
        name: "notion-update-page",
        inputSchema: {
          type: "object",
          properties: { page_id: { type: "string" }, command: { const: "update_content" }, content_updates: { type: "array" }, new_required_guard: { type: "string" } },
          required: ["page_id", "command", "content_updates", "new_required_guard"],
          additionalProperties: false,
        },
      },
    };
    const session = new NotionMcpSession({
      client,
      tools: new Map(Object.entries(tools)),
      traceId: context.traceId, connectionId: connection.id, traces: harness.traces,
    });
    await expect(notionService(harness, fixedSessionProvider(session)).updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "append", section: section.ref, text: "New task" }],
    }, context)).rejects.toMatchObject({ code: "schema_drift" });
    expect(call).not.toHaveBeenCalled();
    expect(writeStates(harness)).toEqual([]);
  });

  it("keeps an ambiguous task write free of applied source and refreshed mutation handles", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_ambiguous", "Tasks");
    const fixture = sessionFixture(async (name) => {
      if (name === "notion-fetch") return { structuredContent: { id: "tasks", text: "## Today\n- [ ] Original\n", truncated: false } };
      throw new McpError(ErrorCode.RequestTimeout, "response lost");
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const read = await compactFetch(harness, service, "tasks");
    const section = read.page.sections[0];
    assert(section !== undefined);
    const context = toolContext(harness, "notion.update_page", "write", read.context.runId);
    await expect(service.updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "append", section: section.ref, text: "Maybe added" }],
    }, context)).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    const persisted = harness.runs.getToolRequired(context.toolExecutionId).result;
    expect(persisted).toEqual({ ok: false, error: { code: "acceptance_unknown", message: "Notion may have accepted the write; it was not repeated" } });
    expect(writeStates(harness)).toEqual(["ambiguous"]);
    expect(fixture.call.mock.calls.filter(([name]) => name === "notion-update-page")).toHaveLength(1);
  });

  it("persists refreshed refs and literal applied source before returning, then reuses them after resuming", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_resume", "Tasks");
    const source = "## Today\n- [ ] Original\n";
    const text = "Keep $& $' $` literal";
    const fixture = sessionFixture(async (name) => name === "notion-fetch"
      ? { structuredContent: { id: "tasks", text: source, truncated: false } }
      : { content: [{ type: "text", text: "accepted" }] });
    const provider = fixedSessionProvider(fixture.session);
    const service = notionService(harness, provider);
    const read = await compactFetch(harness, service, "tasks");
    const section = read.page.sections[0];
    assert(section !== undefined);
    const firstContext = toolContext(harness, "notion.update_page", "write", read.context.runId);
    const result = await service.updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "append", section: section.ref, text }],
    }, firstContext);
    const persisted = harness.runs.getToolRequired(firstContext.toolExecutionId);
    expect(persisted.status).toBe("succeeded");
    expect(persisted.result).toEqual(result);
    expect(result).toMatchObject({ hidden: { page: { id: "tasks", text: `${source}- [ ] ${text}\n`, truncated: false } } });
    const refreshed = compactWriteEnvelopeSchema.parse(persisted.result).result;
    const added = refreshed.sections.flatMap((value) => value.tasks).find((task) => task.text === text);
    assert(added !== undefined);
    expect(refreshed.sections[0]?.ref).not.toBe(section.ref);
    const resumed = notionService(harness, provider);
    await expect(resumed.updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "append", section: section.ref, text: "Stale" }],
    }, toolContext(harness, "notion.update_page", "write", read.context.runId))).rejects.toMatchObject({ code: "task_ref_invalid" });
    await expect(resumed.updatePage({
      workspace: "Tasks", pageId: "tasks", command: "edit_tasks", changes: [{ kind: "check", task: added.ref, checked: true }],
    }, toolContext(harness, "notion.update_page", "write", read.context.runId))).resolves.toMatchObject({
      result: { view: "tasks", sections: [{ tasks: [{ text: "Original", checked: false }, { text, checked: true }] }] },
      hidden: { page: { text: `${source}- [x] ${text}\n` } },
    });
    expect(writeStates(harness)).toEqual(["succeeded", "succeeded"]);
    expect(fixture.call.mock.calls.filter(([name]) => name === "notion-fetch")).toHaveLength(1);
  });

  it("can edit literal dollar-token text introduced by an earlier patch in the same run", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_literal_patch", "Tasks");
    const fixture = sessionFixture(async () => ({ content: [{ type: "text", text: "accepted" }] }));
    const source = "before\nold\nafter\n";
    const replacement = "$& $' $` $$";
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const first = fetchedUpdateContext(harness, "tasks", source);
    await service.updatePage({
      pageId: "tasks", command: "update_content", updates: [{ oldText: "old", newText: replacement, replaceAllMatches: false }],
    }, first);
    await expect(service.updatePage({
      pageId: "tasks", command: "update_content", updates: [{ oldText: replacement, newText: "done", replaceAllMatches: false }],
    }, toolContext(harness, "notion.update_page", "write", first.runId))).resolves.toMatchObject({ outcome: "succeeded" });
    expect(writeStates(harness)).toEqual(["succeeded", "succeeded"]);
  });

  it("rejects duplicate changes to one task without preparing intent", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_duplicate", "Tasks");
    const fixture = sessionFixture(async () => ({ structuredContent: { id: "tasks", text: "## Today\n- [ ] Original\n", truncated: false } }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const read = await compactFetch(harness, service, "tasks");
    const task = read.page.sections.flatMap((section) => section.tasks)[0];
    assert(task !== undefined);
    await expect(service.updatePage({
      pageId: "tasks", command: "edit_tasks",
      changes: [{ kind: "check", task: task.ref, checked: true }, { kind: "check", task: task.ref, checked: false }],
    }, toolContext(harness, "notion.update_page", "write", read.context.runId))).rejects.toMatchObject({ code: "task_change_invalid" });
    expect(writeStates(harness)).toEqual([]);
    expect(fixture.call).toHaveBeenCalledTimes(1);
  });

  it("uses a literal older-section match and keeps the entire visible page within its byte limit", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_bounds", "Tasks");
    const pageId = "p".repeat(1_500);
    const source = Array.from({ length: 5 }, (_, section) =>
      `## Day ${section}\n${Array.from({ length: 15 }, (_, task) => `- [ ] Task ${section}.${task} ${"x".repeat(160)}\n`).join("")}`).join("");
    const fixture = sessionFixture(async () => ({ structuredContent: { id: pageId, text: source, truncated: false } }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const result = await service.fetch({ id: pageId, workspace: "Tasks", view: "tasks", match: "DAY 0" }, toolContext(harness, "notion.fetch", "read", undefined, { id: pageId }));
    const page = compactTaskPageSchema.parse(compactReadEnvelopeSchema.parse(result).result);
    expect(page.id).toBe(pageId);
    expect(page.sections.map((section) => section.path.at(-1))).toEqual(["Day 0"]);
    expect(page.sections[0]?.tasks.length).toBeLessThanOrEqual(12);
    expect(page.sections[0]?.omittedTasks).toBeGreaterThanOrEqual(3);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(6_144);
    expect(result).toMatchObject({ hidden: { page: { text: source } } });
  });

  it("rejects compact identity metadata that cannot fit without clipping the page id", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_identity", "Tasks");
    // UTF-16 length remains within the ordinary id bound; UTF-8 metadata exceeds 6KiB.
    const oversizedPageId = "界".repeat(2_048);
    const oversizedFixture = sessionFixture(async () => ({ structuredContent: { id: oversizedPageId, text: "## Today\n- [ ] Task\n", truncated: false } }));
    await expect(notionService(harness, fixedSessionProvider(oversizedFixture.session)).fetch({
      id: oversizedPageId, view: "tasks",
    }, toolContext(harness, "notion.fetch", "read", undefined, { id: oversizedPageId }))).rejects.toMatchObject({ code: "task_view_too_large" });
    expect(writeStates(harness)).toEqual([]);
  });

  it("does not bypass complete-source hydration limits just because the visible task view is small", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_hydrate_bound", "Tasks");
    const fixture = sessionFixture(async (name) => name === "notion-search"
      ? { structuredContent: { results: [{ id: "tasks" }], truncated: false } }
      : { structuredContent: { id: "tasks", text: `${"private prose ".repeat(2_000)}\n## Today\n- [ ] Task\n`, truncated: false } });
    const result = await notionService(harness, fixedSessionProvider(fixture.session)).search({
      query: "Tasks", workspace: "Tasks", pageSize: 5, hydrate: 1, view: "tasks",
    }, toolContext(harness, "notion.search", "read"));
    expect(result).toMatchObject({ result: { results: [{ id: "tasks" }], pages: [] } });
    expect(writeStates(harness)).toEqual([]);
  });

  it("keeps malformed complete syntax unavailable without issuing task handles or blocking full reads", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_unsupported", "Tasks");
    const source = "## Today\n- [ ] Real task\n```md\n- [ ] Unclosed code\n";
    const fixture = sessionFixture(async (name) => {
      expect(name).toBe("notion-fetch");
      return { structuredContent: { id: "tasks", text: source, truncated: false } };
    });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const context = toolContext(harness, "notion.fetch", "read", undefined, { id: "tasks", view: "tasks" });
    const result = await service.fetch({ id: "tasks", view: "tasks" }, context);
    harness.runs.finishTool(context.toolExecutionId, "succeeded", result);
    expect(result).toMatchObject({ result: { view: "tasks", sourceComplete: true, available: false, sections: [], reason: expect.any(String) }, hidden: { page: { text: source } } });
    await expect(service.updatePage({
      pageId: "tasks", command: "edit_tasks", changes: [{ kind: "append", section: "s_unknown", text: "New task" }],
    }, toolContext(harness, "notion.update_page", "write", context.runId))).rejects.toMatchObject({ code: "task_view_unavailable" });
    await expect(service.fetch({ id: "tasks" }, toolContext(harness, "notion.fetch", "read", context.runId, { id: "tasks" }))).resolves.toEqual({
      workspace: { label: "Tasks" }, result: { id: "tasks", text: source, truncated: false },
    });
    expect(writeStates(harness)).toEqual([]);
  });

  it("preserves CRLF, tabs, trailing spaces, fences, and content wrappers around a task edit", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_bytes", "Tasks");
    const source = '<page>\r\n<content>\r\n# Tasks\r\n## Today\r\n\t- [ ] Existing  \r\n```md\r\n- [ ] Code is not a task\r\n```\r\n\r\n---\r\n\r\n</content>\r\n</page>';
    const fixture = sessionFixture(async (name) => name === "notion-fetch"
      ? { structuredContent: { id: "tasks", text: source, truncated: false } }
      : { content: [{ type: "text", text: "accepted" }] });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const read = await compactFetch(harness, service, "tasks");
    const section = read.page.sections.find((value) => value.path.at(-1) === "Today");
    assert(section !== undefined);
    expect(section.tasks).toHaveLength(1);
    const task = section.tasks[0];
    assert(task !== undefined);
    const text = "Keep $& and $' literal";
    const result = await service.updatePage({
      pageId: "tasks", command: "edit_tasks",
      changes: [{ kind: "check", task: task.ref, checked: true }, { kind: "append", section: section.ref, text }],
    }, toolContext(harness, "notion.update_page", "write", read.context.runId));
    expect(result).toMatchObject({ hidden: { page: {
      text: source.replace("\t- [ ] Existing  ", "\t- [x] Existing  ").replace("\r\n\r\n---", () => `\r\n\t- [ ] ${text}\r\n\r\n---`),
      truncated: false,
    } } });
    expect(writeStates(harness)).toEqual(["succeeded"]);
  });

  it("accepts sixteen appends in caller order, including identical existing task text", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_batch", "Tasks");
    const source = "## Today\n- [ ] Task 0\n";
    const fixture = sessionFixture(async (name) => name === "notion-fetch"
      ? { structuredContent: { id: "tasks", text: source, truncated: false } }
      : { content: [{ type: "text", text: "accepted" }] });
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const read = await compactFetch(harness, service, "tasks");
    const section = read.page.sections[0];
    assert(section !== undefined);
    const texts = Array.from({ length: 16 }, (_, index) => `Task ${index}`);
    const changes: TaskChange[] = texts.map((text) => ({ kind: "append", section: section.ref, text }));
    await expect(service.updatePage({ pageId: "tasks", command: "edit_tasks", changes },
      toolContext(harness, "notion.update_page", "write", read.context.runId))).resolves.toMatchObject({
      hidden: { page: { text: source + texts.map((text) => `- [ ] ${text}\n`).join("") } },
    });
    expect(fixture.call.mock.calls.filter(([name]) => name === "notion-update-page")).toHaveLength(1);
    expect(writeStates(harness)).toEqual(["succeeded"]);
  });

  it("rejects a generated task patch beyond the existing single-patch bound before intent", async () => {
    const harness = notionHarness();
    addNotionConnection(harness, "workspace_task_patch_bound", "Tasks");
    const fixture = sessionFixture(async () => ({ structuredContent: { id: "tasks", text: "## Today\n- [ ] Original\n", truncated: false } }));
    const service = notionService(harness, fixedSessionProvider(fixture.session));
    const read = await compactFetch(harness, service, "tasks");
    const section = read.page.sections[0];
    assert(section !== undefined);
    const changes: TaskChange[] = Array.from({ length: 5 }, () => ({ kind: "append", section: section.ref, text: "x".repeat(2_000) }));
    await expect(service.updatePage({ pageId: "tasks", command: "edit_tasks", changes },
      toolContext(harness, "notion.update_page", "write", read.context.runId))).rejects.toMatchObject({ code: "task_patch_too_large" });
    expect(fixture.call).toHaveBeenCalledTimes(1);
    expect(fixture.validate).not.toHaveBeenCalled();
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

    await expect(service.search({ query: "x", pageSize: 1, hydrate: 0 }, context)).resolves.toEqual({
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

    await expect(service.search({ query: "x", pageSize: 1, hydrate: 0 }, context)).rejects.toMatchObject({
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

  it("opens one MCP session per run and connection, then releases it", async () => {
    // A minimal Streamable HTTP MCP server: counts initializations so reuse is observable.
    let initializations = 0;
    let closed = 0;
    const server = createServer((request, response) => {
      if (request.method === "DELETE") {
        closed += 1;
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method: string };
        const reply = (result: unknown): void => {
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session_1" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };
        if (message.method === "initialize") {
          initializations += 1;
          reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
        } else if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
        } else if (message.method === "tools/list") {
          reply({ tools: [{ name: "notion-search", inputSchema: { type: "object" } }] });
        } else if (message.method === "tools/call") {
          reply({ structuredContent: { results: [], truncated: false } });
        } else {
          response.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address !== null && typeof address === "object");
    const harness = notionHarness();
    const config = loadRuntimeConfig({
      NODE_ENV: "test", DATA_DIR: harness.database.directory,
      DATABASE_PATH: harness.database.config.databasePath, MEMORY_PATH: harness.database.config.memoryPath,
      TRACE_DIR: harness.database.config.traceDir,
      NOTION_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
      SENDBLUE_API_KEY_ID: "k", SENDBLUE_API_SECRET_KEY: "s", SENDBLUE_FROM_NUMBER: "+15551112222",
      USER_PHONE_NUMBER: "+15559990000", PUBLIC_BASE_URL: "https://assistant.example",
      DEEPSEEK_API_KEY: "d", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "g",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    const refresh = new RefreshCoordinator({
      db: harness.database.handle.db, config, connections: harness.connections, traces: harness.traces,
    });
    const provider = new HostedNotionClientProvider(config, refresh, harness.traces);
    const connection = addNotionConnection(harness, "workspace_reuse", "Reuse");
    const traceId = newTraceId();
    const search = (session: NotionSession) => session.call("notion-search", { query: "x", query_type: "internal", page_size: 1 });
    try {
      await provider.withSession(connection.id, traceId, search);
      await provider.withSession(connection.id, traceId, search);
      await Promise.all([provider.withSession(connection.id, traceId, search), provider.withSession(connection.id, traceId, search)]);
      expect(initializations).toBe(1);

      await provider.release(traceId);
      expect(closed).toBe(1);
      await provider.withSession(connection.id, newTraceId(), search);
      expect(initializations).toBe(2);
      await provider.release(traceId);
    } finally {
      await provider.release(traceId);
      server.close();
    }
  });
});

const compactTaskPageSchema = z.object({
  id: z.string().optional(),
  pageId: z.string().optional(),
  view: z.literal("tasks"),
  sourceComplete: z.literal(true),
  available: z.literal(true),
  sections: z.array(z.object({
    ref: z.string(),
    path: z.array(z.string()),
    tasks: z.array(z.object({ ref: z.string(), text: z.string(), checked: z.boolean() })),
    omittedTasks: z.number(),
  })),
  omittedSections: z.number(),
  totalSections: z.number(),
  ordering: z.enum(["document_tail", "matched_document_tail", "changed_sections"]),
}).loose();
const compactReadEnvelopeSchema = z.object({ result: z.unknown() });
const compactSearchEnvelopeSchema = z.object({ result: z.object({ pages: z.array(compactTaskPageSchema) }) });
const compactWriteEnvelopeSchema = z.object({ result: compactTaskPageSchema });
const providerTaskPatchSchema = z.tuple([z.object({
  old_str: z.string().min(1).max(8_000),
  new_str: z.string().max(8_000),
  replace_all_matches: z.literal(false),
})]);

async function compactFetch(
  harness: NotionHarness,
  service: NotionToolService,
  pageId: string,
  runId?: RunId,
  workspace = "Tasks",
): Promise<{ context: ToolExecutionContext; page: z.infer<typeof compactTaskPageSchema> }> {
  const context = toolContext(harness, "notion.fetch", "read", runId, { id: pageId, workspace, view: "tasks" });
  const result = await service.fetch({ id: pageId, workspace, view: "tasks" }, context);
  harness.runs.finishTool(context.toolExecutionId, "succeeded", result);
  return { context, page: compactTaskPageSchema.parse(compactReadEnvelopeSchema.parse(result).result) };
}

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
