import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentRunStore } from "../agent/store.js";
import { parseToolArguments, type RegisteredTool, type ToolExecutionContext } from "../agent/tools.js";
import type { ConnectionRouter } from "../connections/router.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionCapability, ConnectionRecord } from "../connections/types.js";
import { ModelSafeError } from "../core/errors.js";
import type { TraceId } from "../core/ids.js";
import { canonicalJson } from "../core/json.js";
import type { WriteStore } from "../writes/store.js";
import { NotionMcpError, type NotionClientProvider, type NotionUpstreamTool } from "./client.js";
import { planTaskEdit, projectTasks, type TaskPlan, type TaskProjection } from "./tasks.js";

const accountSchema = z.string().trim().min(1).max(160).optional();
const viewSchema = z.enum(["full", "tasks"]).optional();
const matchSchema = z.string().min(1).max(512)
  .refine((value) => value.trim().length > 0 && !/[\r\n\u2028\u2029]/u.test(value), "Use a nonempty single-line match");
const searchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    workspace: accountSchema,
    pageSize: z.number().int().min(1).max(10).default(10),
    hydrate: z.number().int().min(0).max(3).default(0),
    view: viewSchema,
    match: matchSchema.optional(),
  })
  .strict()
  .refine((input) => input.view === "tasks" || input.match === undefined, "match requires view:tasks")
  .refine((input) => input.view !== "tasks" || input.hydrate > 0, "view:tasks requires hydrate:1 or higher");
const upstreamSearchArgumentsSchema = z
  .object({ page_size: z.number().int().min(1).max(50) })
  .loose();
const fetchArgumentsSchema = z
  .object({
    id: z.string().trim().min(1).max(2_048),
    workspace: accountSchema,
    view: viewSchema,
    match: matchSchema.optional(),
  })
  .strict()
  .refine((input) => input.view === "tasks" || input.match === undefined, "match requires view:tasks");
const propertyValueSchema = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const propertiesSchema = z
  .record(z.string().min(1).max(200), propertyValueSchema)
  .refine((properties) => {
    const count = Object.keys(properties).length;
    return count >= 1 && count <= 50;
  }, "One to fifty properties are required");
const parentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), id: z.string().min(1).max(2_048) }).strict(),
  z.object({ type: z.literal("data_source"), id: z.string().min(1).max(2_048) }).strict(),
]);
const createPageArgumentsSchema = z
  .object({
    workspace: accountSchema,
    parent: parentSchema.optional(),
    properties: propertiesSchema,
    content: z.string().max(48_000).optional(),
  })
  .strict();
const updatePropertiesSchema = z
  .object({
    workspace: accountSchema,
    pageId: z.string().min(1).max(2_048),
    command: z.literal("update_properties"),
    properties: propertiesSchema.refine(
      (properties) => Object.keys(properties).length === 1,
      "Update one property at a time",
    ),
  })
  .strict();
const replaceContentSchema = z
  .object({
    workspace: accountSchema,
    pageId: z.string().min(1).max(2_048),
    command: z.literal("replace_content"),
    newContent: z.string().max(48_000),
  })
  .strict();
const contentUpdateSchema = z
  .object({
    oldText: z.string().min(1).max(8_000),
    newText: z.string().max(8_000),
    replaceAllMatches: z.literal(false).default(false),
  })
  .strict();
const updateContentSchema = z
  .object({
    workspace: accountSchema,
    pageId: z.string().min(1).max(2_048),
    command: z.literal("update_content"),
    updates: z.tuple([contentUpdateSchema]),
  })
  .strict();
const taskChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("append"),
    section: z.string().min(1).max(160),
    text: z.string().min(1).max(2_000)
      .refine((value) => value.trim().length > 0 && !/[\r\n\u2028\u2029]/u.test(value), "Use nonempty single-line task text"),
  }).strict(),
  z.object({
    kind: z.literal("check"),
    task: z.string().min(1).max(160),
    checked: z.boolean(),
  }).strict(),
]);
const editTasksSchema = z.object({
  workspace: accountSchema,
  pageId: z.string().min(1).max(2_048),
  command: z.literal("edit_tasks"),
  changes: z.array(taskChangeSchema).min(1).max(16),
}).strict();
const updatePageArgumentsSchema = z.discriminatedUnion("command", [
  updatePropertiesSchema,
  replaceContentSchema,
  updateContentSchema,
  editTasksSchema,
]);
const toolResultSchema = z
  .object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z
      .array(
        z
          .object({
            type: z.string(),
            text: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
const maximumResultBytes = 131_072;
const notionReferenceSchema = z
  .object({
    id: z.string().min(1).max(2_048).optional(),
    title: z.string().max(4_096).optional(),
    url: z.string().max(8_192).optional(),
    type: z.string().max(128).optional(),
    highlight: z.string().max(16_384).optional(),
    text_snippet: z.string().max(16_384).optional(),
    timestamp: z.string().max(128).optional(),
  })
  .loose();
interface NormalizedNotionReference {
  readonly id?: string;
  readonly title?: string;
  readonly url?: string;
  readonly type?: string;
  readonly highlight?: string;
  readonly timestamp?: string;
}

interface NormalizedNotionSearchResult {
  readonly results: readonly NormalizedNotionReference[];
  readonly truncated: boolean;
}

interface NormalizedNotionTextResult {
  readonly text: string;
  readonly truncated: boolean;
}

/** Full normalized source, used by ordinary reads and private compact-read provenance. */
interface NormalizedNotionPage {
  readonly id?: string;
  readonly title?: string;
  readonly url?: string;
  readonly type?: string;
  readonly text?: string;
  readonly truncated: boolean;
}

// Hydration bounds mirror gmail.search: enough for a task page or a note, never a report.
const maximumHydratedPageBytes = 24_576;
const maximumHydrationBytes = 49_152;

const fetchedPageSchema = z.object({
  workspace: z.object({ label: z.string() }),
  result: z.object({
    id: z.string().optional(),
    text: z.string().optional(),
    truncated: z.literal(false),
  }),
});

type NotionWriteResult =
  | {
      ok: true;
      outcome: "succeeded";
      workspace: { label: string };
      result: unknown;
      /** Runtime provenance, persisted on the tool row and never sent to the model. */
      hidden?: { page: { id: string; text: string; truncated: false } };
    }
  | {
      ok: true;
      outcome: "unchanged";
      workspace: { label: string };
      result: { pageId: string } | ({ pageId: string } & TaskProjection);
      hidden?: { page: { id: string; text: string; truncated: false } };
    };

const notionSearchResultSchema = z
  .object({ results: z.array(notionReferenceSchema).max(100) })
  .loose();
const notionFetchResultSchema = z
  .object({
    id: z.string().min(1).max(2_048).optional(),
    title: z.string().max(4_096).optional(),
    url: z.string().max(8_192).optional(),
    type: z.string().max(128).optional(),
    text: z.string().max(maximumResultBytes).optional(),
    content: z.string().max(maximumResultBytes).optional(),
    markdown: z.string().max(maximumResultBytes).optional(),
    unknown_block_ids: z.array(z.string().min(1).max(2_048)).max(50).optional(),
    unknown_block_count: z.number().int().min(0).optional(),
  })
  .loose();
const notionCreateResultSchema = z
  .object({
    pages: z.array(notionReferenceSchema.required({ id: true })).min(1).max(10).optional(),
    id: z.string().min(1).max(2_048).optional(),
    url: z.string().max(8_192).optional(),
  })
  .loose()
  .refine((value) => value.pages !== undefined || value.id !== undefined);

export class NotionToolService {
  readonly #db: Database.Database;
  readonly #router: ConnectionRouter;
  readonly #connections: ConnectionStore;
  readonly #clients: NotionClientProvider;
  readonly #runs: AgentRunStore;
  readonly #writes: WriteStore;

  constructor(input: {
    db: Database.Database;
    router: ConnectionRouter;
    connections: ConnectionStore;
    clients: NotionClientProvider;
    runs: AgentRunStore;
    writes: WriteStore;
  }) {
    this.#db = input.db;
    this.#router = input.router;
    this.#connections = input.connections;
    this.#clients = input.clients;
    this.#runs = input.runs;
    this.#writes = input.writes;
  }

  tools(): readonly RegisteredTool[] {
    return [
      {
        definition: {
          name: "notion.search",
          description: "Search one Notion workspace using its exact safe label. For task actions use a short title query, hydrate:1, view:tasks; reuse the selected page's id and refs without refetching. A known personal task page needs no owner clarification. Only when sections name different people, select the requested owner or user's name in memory; no matching owner means ask once and write nothing. Never infer ownership from Annie or account details. An undated new task goes in the target's last matching section. Compact pages retain complete source privately. Use hydrate:0 for broad discovery, or default view:full for general text. match is a single-line literal filter for older heading paths/task text and requires view:tasks.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 512 },
              workspace: { type: "string", minLength: 1, maxLength: 160 },
              pageSize: { type: "integer", minimum: 1, maximum: 10, default: 10 },
              hydrate: { type: "integer", minimum: 0, maximum: 3, default: 0 },
              view: { enum: ["full", "tasks"], default: "full" },
              match: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\r\\n\\u2028\\u2029]+$" },
            },
            required: ["query"],
            allOf: [
              { if: { properties: { match: {} }, required: ["match"] }, then: { properties: { view: { const: "tasks" } }, required: ["view"] } },
              { if: { properties: { view: { const: "tasks" } }, required: ["view"] }, then: { properties: { hydrate: { type: "integer", minimum: 1 } }, required: ["hydrate"] } },
            ],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        batchMode: "parallel_read",
        execute: async (argumentsValue, context) =>
          this.search(parseToolArguments(searchArgumentsSchema, argumentsValue), context),
      },
      {
        definition: {
          name: "notion.fetch",
          description: "Read a Notion item by its returned id and safe workspace label. view:tasks returns bounded section/task refs for semantic edits; match selects older heading paths/task text by case-insensitive literal substring. Default view:full reads general text. Fetch only when search did not hydrate the selected page or its source is incomplete.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 2_048 },
              workspace: { type: "string", minLength: 1, maxLength: 160 },
              view: { enum: ["full", "tasks"], default: "full" },
              match: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\r\\n\\u2028\\u2029]+$" },
            },
            required: ["id"],
            allOf: [
              { if: { properties: { match: {} }, required: ["match"] }, then: { properties: { view: { const: "tasks" } }, required: ["view"] } },
            ],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        batchMode: "parallel_read",
        execute: async (argumentsValue, context) =>
          this.fetch(parseToolArguments(fetchArgumentsSchema, argumentsValue), context),
      },
      {
        definition: {
          name: "notion.create_page",
          description: "Create one new Notion page, not a task on an existing page. Supply properties such as {\"title\":\"Project notes\"} and optional content; use a parent returned from that workspace when the user names a destination. To add a checkbox to an existing task page, use notion.update_page instead. A written reply alone creates nothing.",
          parameters: {
            type: "object",
            properties: {
              workspace: { type: "string", minLength: 1, maxLength: 160 },
              parent: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      type: { const: "page" },
                      id: { type: "string", minLength: 1, maxLength: 2_048 },
                    },
                    required: ["type", "id"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      type: { const: "data_source" },
                      id: { type: "string", minLength: 1, maxLength: 2_048 },
                    },
                    required: ["type", "id"],
                    additionalProperties: false,
                  },
                ],
              },
              properties: {
                type: "object",
                minProperties: 1,
                maxProperties: 50,
                additionalProperties: {
                  anyOf: [
                    { type: "string", maxLength: 4_000 },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" },
                  ],
                },
              },
              content: { type: "string", maxLength: 48_000 },
            },
            required: ["properties"],
            additionalProperties: false,
          },
        },
        operationClass: "write",
        execute: async (argumentsValue, context) =>
          this.createPage(parseToolArguments(createPageArgumentsSchema, argumentsValue), context),
      },
      {
        definition: {
          name: "notion.update_page",
          description: "Edit a complete page read this run using its pageId and same workspace. For tasks use command:edit_tasks with changes:[{kind:'append',section:<section ref>,text:'New task'}] or [{kind:'check',task:<task ref>,checked:true}]; combine up to16 changes in user order. Use current refs, never reconstruct them. Append adds a checkbox even if its text already exists. outcome:unchanged means already matched. For general edits use update_content with one unique oldText copied VERBATIM from full result.text and literal newText. Local target/ref errors sent no write. Never replay an ambiguous provider write. update_properties changes one property; replace_content is only for an explicitly requested full rewrite. Moving, deleting, archiving are unavailable.",
          parameters: {
            type: "object",
            properties: {
              workspace: { type: "string", minLength: 1, maxLength: 160 },
              pageId: { type: "string", minLength: 1, maxLength: 2_048 },
              command: {
                enum: ["update_properties", "replace_content", "update_content", "edit_tasks"],
              },
              properties: {
                type: "object",
                minProperties: 1,
                maxProperties: 1,
                additionalProperties: {
                  anyOf: [
                    { type: "string", maxLength: 4_000 },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" },
                  ],
                },
              },
              newContent: { type: "string", maxLength: 48_000 },
              updates: {
                type: "array",
                minItems: 1,
                maxItems: 1,
                items: {
                  type: "object",
                  properties: {
                    oldText: { type: "string", minLength: 1, maxLength: 8_000 },
                    newText: { type: "string", maxLength: 8_000 },
                    replaceAllMatches: { const: false, default: false },
                  },
                  required: ["oldText", "newText"],
                  additionalProperties: false,
                },
              },
              changes: {
                type: "array",
                minItems: 1,
                maxItems: 16,
                items: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        kind: { const: "append" },
                        section: { type: "string", minLength: 1, maxLength: 160 },
                        text: { type: "string", minLength: 1, maxLength: 2_000, pattern: "^[^\\r\\n\\u2028\\u2029]+$" },
                      },
                      required: ["kind", "section", "text"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        kind: { const: "check" },
                        task: { type: "string", minLength: 1, maxLength: 160 },
                        checked: { type: "boolean" },
                      },
                      required: ["kind", "task", "checked"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            required: ["workspace", "pageId", "command"],
            // Each command owns exactly its fields; the others are forbidden, not ignored, so
            // a stray `newContent` on an update is rejected here by name instead of failing
            // later as an opaque error.
            allOf: [
              {
                if: { properties: { command: { const: "update_properties" } } },
                then: {
                  properties: { properties: { type: "object" }, newContent: false, updates: false, changes: false },
                  required: ["properties"],
                },
              },
              {
                if: { properties: { command: { const: "replace_content" } } },
                then: {
                  properties: { newContent: { type: "string" }, properties: false, updates: false, changes: false },
                  required: ["newContent"],
                },
              },
              {
                if: { properties: { command: { const: "update_content" } } },
                then: {
                  properties: { updates: { type: "array" }, newContent: false, properties: false, changes: false },
                  required: ["updates"],
                },
              },
              {
                if: { properties: { command: { const: "edit_tasks" } } },
                then: {
                  properties: { changes: { type: "array" }, properties: false, newContent: false, updates: false },
                  required: ["changes"],
                },
              },
            ],
            additionalProperties: false,
          },
        },
        operationClass: "write",
        execute: async (argumentsValue, context) =>
          this.updatePage(parseToolArguments(updatePageArgumentsSchema, argumentsValue), context),
      },
    ];
  }

  async search(
    input: z.infer<typeof searchArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    if ((input.match !== undefined && input.view !== "tasks") || (input.view === "tasks" && input.hydrate === 0)) {
      parseToolArguments(searchArgumentsSchema, input);
    }
    const connection = this.#select("notion.search", input.workspace, context);
    const hydrated = await this.#clients.withSession(
      connection.id,
      context.traceId,
      async (session) => {
        const request = {
          query: input.query,
          query_type: "internal",
          page_size: input.pageSize,
        } as const;
        const search = normalizeNotionResult(
          "notion-search",
          await session.call("notion-search", request),
          request,
        );
        if (input.hydrate === 0 || !("results" in search)) {
          return { result: search };
        }
        // Hydration: the top results' full text in the same tool round, so the usual
        // search-then-fetch pair costs one model round instead of two. Each page is the
        // exact notion.fetch shape, bounded per page and in total; a page that fails or
        // overflows is simply absent, and the search result itself is never lost.
        const pages: NormalizedNotionPage[] = [];
        const sources = new Map<string, NormalizedNotionPage>();
        let bytes = 0;
        for (const reference of search.results.slice(0, input.hydrate)) {
          if (reference.id === undefined) continue;
          sources.set(reference.id, { id: reference.id, truncated: true });
          let page: NormalizedNotionPage;
          try {
            page = normalizeNotionResult("notion-fetch", await session.call("notion-fetch", { id: reference.id }));
          } catch (error) {
            if (error instanceof NotionMcpError || error instanceof NotionToolResultError) continue;
            throw error;
          }
          if (page.id !== undefined && page.id !== reference.id) continue;
          const size = Buffer.byteLength(canonicalJson(page));
          if (size > maximumHydratedPageBytes || bytes + size > maximumHydrationBytes) break;
          bytes += size;
          const completePage = { ...page, id: reference.id };
          pages.push(completePage);
          sources.set(reference.id, completePage);
        }
        return { result: { ...search, pages }, sources: [...sources.values()] };
      },
      context.signal,
    );
    const result = hydrated.result;
    const sources = "sources" in hydrated ? hydrated.sources : undefined;
    this.#markHealthy(connection, context.traceId);
    if (input.view === "tasks") {
      const pages = "pages" in result ? result.pages : [];
      return {
        workspace: { label: connection.safeLabel },
        result: {
          ...("results" in result
            ? { results: result.results.map(({ highlight: _highlight, ...reference }) => reference) }
            : { results: [], available: false, reason: "Search did not return page references; fetch a known page id for its task view." }),
          truncated: result.truncated,
          pages: pages.map((page) => this.#taskPage(page, page.id ?? "", connection, context, input.match)),
        },
        hidden: { pages: sources ?? pages },
      };
    }
    const incompletePages = sources?.filter((page) => page.truncated).map(({ id }) => ({ id, truncated: true }));
    return {
      workspace: { label: connection.safeLabel }, result,
      ...(incompletePages?.length ? { hidden: { pages: incompletePages } } : {}),
    };
  }

  async fetch(
    input: z.infer<typeof fetchArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    if (input.match !== undefined && input.view !== "tasks") {
      parseToolArguments(fetchArgumentsSchema, input);
    }
    const connection = this.#select("notion.fetch", input.workspace, context);
    const result = await this.#clients.withSession(connection.id, context.traceId, async (session) =>
      normalizeNotionResult(
        "notion-fetch",
        await session.call("notion-fetch", { id: input.id }),
      ),
      context.signal,
    );
    this.#markHealthy(connection, context.traceId);
    if (input.view === "tasks") {
      return {
        workspace: { label: connection.safeLabel },
        result: this.#taskPage(result, result.id ?? input.id, connection, context, input.match),
        hidden: { page: result },
      };
    }
    return { workspace: { label: connection.safeLabel }, result };
  }

  async createPage(
    input: z.infer<typeof createPageArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<NotionWriteResult> {
    const connection = this.#select("notion.create_page", input.workspace, context);
    const upstream = {
      ...(input.parent === undefined
        ? {}
        : {
            parent:
              input.parent.type === "page"
                ? { page_id: input.parent.id }
                : { data_source_id: input.parent.id },
          }),
      pages: [
        {
          properties: input.properties,
          ...(input.content === undefined ? {} : { content: input.content }),
        },
      ],
    };
    return this.#write({
      connection,
      context,
      upstreamName: "notion-create-pages",
      writeKind: "notion_create_page",
      argumentsValue: upstream,
      safeSummary: {
        propertyCount: Object.keys(input.properties).length,
        contentBytes: Buffer.byteLength(input.content ?? ""),
      },
    });
  }

  async updatePage(
    input: z.infer<typeof updatePageArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<NotionWriteResult> {
    const connection = this.#select("notion.update_page", input.workspace, context);
    const page = this.#fetchedPage(input.pageId, connection, context);
    let edit: Exclude<z.infer<typeof updatePageArgumentsSchema>, { command: "edit_tasks" }>;
    let plannedTaskEdit: Extract<TaskPlan, { outcome: "changed" }> | undefined;
    if (input.command === "edit_tasks") {
      if (page.text === undefined) {
        throw new ModelSafeError("NotionWriteTargetError", "write_target_unverified", "Read the complete page text in this request before editing tasks.");
      }
      const plan = planTaskEdit(page.text, this.#taskBinding(input.pageId, connection, context), input.changes, {
        maxViewBytes: taskViewBytes({ pageId: input.pageId }),
      });
      if (plan.outcome === "unchanged") {
        return {
          ok: true,
          outcome: "unchanged",
          workspace: { label: connection.safeLabel },
          result: { pageId: input.pageId, ...plan.view },
          hidden: { page: { id: input.pageId, text: page.text, truncated: false } },
        };
      }
      plannedTaskEdit = plan;
      edit = parseToolArguments(updateContentSchema, {
        workspace: input.workspace,
        pageId: input.pageId,
        command: "update_content",
        updates: [{ oldText: plan.oldText, newText: plan.newText, replaceAllMatches: false }],
      });
    } else {
      edit = input;
    }
    let unchanged = false;
    if (edit.command === "update_content") {
      const [update] = edit.updates;
      const offset = page.text?.indexOf(update.oldText) ?? -1;
      if (offset < 0) {
        throw new ModelSafeError(
          "NotionWriteTargetError",
          "write_target_not_found",
          "No provider write was sent: oldText does not occur in the fetched text. Copy it verbatim from the current result, preserving punctuation, whitespace, and newlines; do not reconstruct it. Refetch only if the source is incomplete or stale.",
        );
      }
      if (page.text?.indexOf(update.oldText, offset + 1) !== -1) {
        throw new ModelSafeError(
          "NotionWriteTargetError",
          "write_target_ambiguous",
          "No provider write was sent: oldText occurs more than once. Extend the exact copied span with its section heading or neighboring lines until it identifies one location.",
        );
      }
      unchanged = update.oldText === update.newText;
    } else if (edit.command === "replace_content") {
      if (page.text === undefined) {
        throw new ModelSafeError(
          "NotionWriteTargetError",
          "write_target_unverified",
          "Fetch the complete page text before replacing its content.",
        );
      }
      unchanged = edit.newContent === page.text;
    }
    if (unchanged) {
      return {
        ok: true,
        outcome: "unchanged",
        workspace: { label: connection.safeLabel },
        result: { pageId: input.pageId },
      };
    }
    // A succeeded content patch knows exactly what the page now says: the old span
    // replaced at its one position. That applied text rides on the write's own result and
    // becomes the latest same-run read, so a following patch is proven against the page
    // as it truly is: a span the first patch consumed is rejected as absent, and one it
    // introduced is available. A property update leaves the text untouched.
    let applied = plannedTaskEdit?.appliedText ?? page.text;
    if (plannedTaskEdit === undefined && edit.command === "update_content" && page.text !== undefined) {
      const [update] = edit.updates;
      applied = page.text.replace(update.oldText, () => update.newText);
    } else if (edit.command === "replace_content") {
      applied = edit.newContent;
    }
    return this.#write({
      connection,
      context,
      upstreamName: "notion-update-page",
      writeKind: "notion_update_page",
      argumentsValue: toUpdateArguments(edit),
      safeSummary: {
        command: input.command,
        pageId: input.pageId,
      },
      ...(applied === undefined ? {} : { appliedPage: { id: input.pageId, text: applied, truncated: false as const } }),
      ...(plannedTaskEdit === undefined ? {} : { taskView: plannedTaskEdit.view }),
    });
  }

  #taskBinding(pageId: string, connection: ConnectionRecord, context: ToolExecutionContext): string {
    return canonicalJson({
      runId: context.runId,
      connectionId: connection.id,
      credentialGeneration: connection.credentialGeneration,
      pageId,
    });
  }

  #taskPage(
    page: NormalizedNotionPage,
    pageId: string,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
    match: string | undefined,
  ): unknown {
    const metadata = { id: pageId };
    const maxBytes = taskViewBytes(metadata);
    if (page.truncated || page.text === undefined) {
      const result = {
        ...metadata,
        view: "tasks",
        sourceComplete: false,
        available: false,
        reason: "Complete source text is unavailable; fetch this page completely before editing tasks.",
      };
      if (Buffer.byteLength(canonicalJson(result)) > maximumCompactPageBytes) {
        throw new ModelSafeError("NotionTaskViewError", "task_view_too_large", "This page id leaves no room for a compact task view.");
      }
      return result;
    }
    return {
      ...metadata,
      ...projectTasks(page.text, this.#taskBinding(pageId, connection, context), {
        ...(match === undefined ? {} : { match }),
        maxBytes,
      }),
    };
  }

  /**
   * Select the latest same-run, same-connection source before checking completeness.
   * Full fetches, hydrated pages, private compact-read source, and succeeded applied
   * content all count. A newer incomplete source must block an older complete one.
   */
  #fetchedPage(
    pageId: string,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): z.infer<typeof fetchedPageSchema>["result"] {
    const row = this.#db
      .prepare<
        { run_id: string; connection_id: string; page_id: string },
        { page_json: string }
      >(`
        SELECT page_json FROM (
          SELECT rowid, 0 AS source_order, json_object('workspace', json_extract(result_json, '$.workspace'),
                                    'result', COALESCE(json_extract(result_json, '$.hidden.page'),
                                                       json_extract(result_json, '$.result'))) AS page_json
          FROM tool_executions
          WHERE run_id = @run_id AND connection_id = @connection_id
            AND tool_name = 'notion.fetch' AND status = 'succeeded'
            AND json_extract(arguments_json, '$.id') = @page_id
            AND result_json IS NOT NULL
          UNION ALL
          SELECT executions.rowid, pages.key AS source_order, json_object('workspace', json_extract(executions.result_json, '$.workspace'),
                                               'result', pages.value) AS page_json
          FROM tool_executions AS executions,
               json_each(CASE WHEN EXISTS (
                 SELECT 1 FROM json_each(json_extract(executions.result_json, '$.hidden.pages')) AS private_pages
                 WHERE json_extract(private_pages.value, '$.id') = @page_id
               ) THEN json_extract(executions.result_json, '$.hidden.pages')
                 ELSE json_extract(executions.result_json, '$.result.pages') END) AS pages
          WHERE executions.run_id = @run_id AND executions.connection_id = @connection_id
            AND executions.tool_name = 'notion.search' AND executions.status = 'succeeded'
            AND json_extract(pages.value, '$.id') = @page_id
          UNION ALL
          SELECT rowid, 0 AS source_order, json_object('workspace', json_extract(result_json, '$.workspace'),
                                    'result', json_extract(result_json, '$.hidden.page')) AS page_json
          FROM tool_executions
          WHERE run_id = @run_id AND connection_id = @connection_id
            AND tool_name = 'notion.update_page' AND status = 'succeeded'
            AND json_extract(result_json, '$.hidden.page.id') = @page_id
        )
        ORDER BY rowid DESC, source_order DESC
        LIMIT 1
      `)
      .get({
        run_id: context.runId,
        connection_id: connection.id,
        page_id: pageId,
      });
    const fetched = fetchedPageSchema.safeParse(
      row === undefined ? undefined : JSON.parse(row.page_json),
    );
    if (
      !fetched.success ||
      fetched.data.workspace.label !== connection.safeLabel ||
      (fetched.data.result.id !== undefined && fetched.data.result.id !== pageId)
    ) {
      throw new ModelSafeError(
        "NotionWriteTargetError",
        "write_target_unverified",
        "Fetch this page completely in the selected workspace during this request before editing it.",
      );
    }
    return fetched.data.result;
  }

  async #write(input: {
    connection: ConnectionRecord;
    context: ToolExecutionContext;
    upstreamName: Extract<NotionUpstreamTool, "notion-create-pages" | "notion-update-page">;
    writeKind: "notion_create_page" | "notion_update_page";
    argumentsValue: Record<string, unknown>;
    safeSummary: unknown;
    appliedPage?: { id: string; text: string; truncated: false };
    taskView?: TaskProjection;
  }): Promise<NotionWriteResult> {
    return this.#clients.withSession(
      input.connection.id,
      input.context.traceId,
      async (session) => {
        session.validate(input.upstreamName, input.argumentsValue);
        const write = this.#writes.prepare({
          traceId: input.context.traceId,
          runId: input.context.runId,
          toolExecutionId: input.context.toolExecutionId,
          connectionId: input.connection.id,
          connectionGeneration: input.connection.credentialGeneration,
          kind: input.writeKind,
          request: input.argumentsValue,
          safeSummary: input.safeSummary,
        });
        this.#writes.beginAttempt({
          writeId: write.id,
          traceId: input.context.traceId,
          ...(input.context.jobLease === undefined
            ? {}
            : { jobLease: { ...input.context.jobLease, nowMs: Date.now() } }),
        });
        try {
          const result = normalizeNotionResult(
            input.upstreamName,
            await session.call(input.upstreamName, input.argumentsValue),
            input.argumentsValue,
          );
          const normalized: NotionWriteResult = {
            ok: true,
            outcome: "succeeded",
            workspace: { label: input.connection.safeLabel },
            result: input.taskView === undefined
              ? result
              : { pageId: String(input.argumentsValue.page_id), ...input.taskView },
            ...(input.appliedPage === undefined ? {} : { hidden: { page: input.appliedPage } }),
          };
          this.#writes.complete({
            writeId: write.id,
            traceId: input.context.traceId,
            state: "succeeded",
            normalizedResult: normalized,
          });
          this.#markHealthy(input.connection, input.context.traceId);
          return normalized;
        } catch (error) {
          if (this.#writes.get(write.id)?.state === "attempting") {
            this.#writes.complete({
              writeId: write.id,
              traceId: input.context.traceId,
              state: "ambiguous",
              normalizedResult: {
                ok: false,
                error: {
                  code: "acceptance_unknown",
                  message: "Notion may have accepted the write; it was not repeated",
                },
              },
            });
          }
          throw error;
        }
      },
      input.context.signal,
    );
  }

  #select(
    capability: ConnectionCapability,
    workspace: string | undefined,
    context: ToolExecutionContext,
  ): ConnectionRecord {
    const connection = this.#router.select({
      capabilities: [capability],
      ...(context.connectionId === null
        ? workspace === undefined
          ? {}
          : { account: workspace }
        : { connectionId: context.connectionId }),
    });
    this.#runs.bindToolConnection(context.toolExecutionId, connection.id);
    return connection;
  }


  #markHealthy(connection: ConnectionRecord, traceId: TraceId): void {
    this.#connections.markHealthy({
      connectionId: connection.id,
      credentialGeneration: connection.credentialGeneration,
      traceId,
    });
  }
}

export class NotionToolResultError extends ModelSafeError<"provider_rejected"> {
  constructor() {
    super("NotionToolResultError", "provider_rejected", "Notion reported a tool error");
  }
}

function toUpdateArguments(
  input: Exclude<z.infer<typeof updatePageArgumentsSchema>, { command: "edit_tasks" }>,
): Record<string, unknown> {
  if (input.command === "update_properties") {
    return {
      page_id: input.pageId,
      command: input.command,
      properties: input.properties,
    };
  }
  if (input.command === "replace_content") {
    return {
      page_id: input.pageId,
      command: input.command,
      new_str: input.newContent,
    };
  }
  return {
    page_id: input.pageId,
    command: input.command,
    content_updates: input.updates.map((update) => ({
      old_str: update.oldText,
      new_str: update.newText,
      replace_all_matches: update.replaceAllMatches,
    })),
  };
}

const maximumCompactPageBytes = 6_144;

function taskViewBytes(metadata: { id: string } | { pageId: string }): number {
  const maximumBytes = maximumCompactPageBytes - Buffer.byteLength(canonicalJson(metadata)) + 1;
  if (maximumBytes <= 0) {
    throw new ModelSafeError("NotionTaskViewError", "task_view_too_large", "This page id leaves no room for a compact task view.");
  }
  return maximumBytes;
}

function normalizeNotionResult(
  name: "notion-search",
  raw: unknown,
  argumentsValue: Record<string, unknown>,
): NormalizedNotionSearchResult | NormalizedNotionTextResult;
function normalizeNotionResult(
  name: "notion-fetch",
  raw: unknown,
  argumentsValue?: Record<string, unknown>,
): NormalizedNotionPage;
function normalizeNotionResult(
  name: Exclude<NotionUpstreamTool, "notion-search" | "notion-fetch">,
  raw: unknown,
  argumentsValue?: Record<string, unknown>,
): unknown;

function normalizeNotionResult(
  name: NotionUpstreamTool,
  raw: unknown,
  argumentsValue: Record<string, unknown> = {},
): unknown {
  const envelope = toolResultSchema.parse(raw);
  if (envelope.isError === true) {
    throw new NotionToolResultError();
  }
  if (name === "notion-update-page") {
    assertNotionWriteAccepted(envelope);
    return { pageId: String(argumentsValue.page_id), updated: true };
  }
  if (name === "notion-create-pages") {
    // Same acceptance rule as update. Page ids and URLs are reported when the body carries
    // them; a rendered or truncated body does not turn an accepted create into an unknown one,
    // which is how a created "logit notes" page was once reported as acceptance-unknown.
    assertNotionWriteAccepted(envelope);
    const parsed = notionCreateResultSchema.safeParse(normalizedNotionPayload(envelope).value);
    const pages = !parsed.success
      ? []
      : parsed.data.pages ??
        (parsed.data.id === undefined
          ? []
          : [{ id: parsed.data.id, ...(parsed.data.url === undefined ? {} : { url: parsed.data.url }) }]);
    return {
      pages: pages.map((page) => ({
        id: page.id,
        ...(page.title === undefined ? {} : { title: page.title }),
        ...(page.url === undefined ? {} : { url: page.url }),
      })),
    };
  }

  const payload = normalizedNotionPayload(envelope);
  if (name === "notion-search") {
    if (typeof payload.value === "string") {
      return { text: payload.value, truncated: payload.truncated };
    }
    const pageSize = upstreamSearchArgumentsSchema.parse(argumentsValue).page_size;
    const parsed = notionSearchResultSchema.parse(payload.value);
    return {
      results: parsed.results.map((result) => ({
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.title === undefined ? {} : { title: result.title }),
        ...(result.url === undefined ? {} : { url: result.url }),
        ...(result.type === undefined ? {} : { type: result.type }),
        ...(result.highlight === undefined && result.text_snippet === undefined
          ? {}
          : { highlight: result.highlight ?? result.text_snippet }),
        ...(result.timestamp === undefined ? {} : { timestamp: result.timestamp }),
      })),
      truncated:
        payload.truncated ||
        (payload.providerTruncation === undefined && parsed.results.length >= pageSize),
    };
  }
  if (typeof payload.value === "string") {
    return { text: payload.value, truncated: payload.truncated };
  }
  const parsed = notionFetchResultSchema.parse(payload.value);
  const text = parsed.text ?? parsed.content ?? parsed.markdown;
  const omittedBlocks =
    (parsed.unknown_block_ids?.length ?? 0) > 0 || (parsed.unknown_block_count ?? 0) > 0;
  return {
    ...(parsed.id === undefined ? {} : { id: parsed.id }),
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.url === undefined ? {} : { url: parsed.url }),
    ...(parsed.type === undefined ? {} : { type: parsed.type }),
    ...(text === undefined ? {} : { text }),
    truncated: payload.truncated || omittedBlocks,
  };
}

// A non-error MCP result is Notion's acceptance of a write. The body is a rendered page
// view, not a receipt; its shape and truncation say nothing about the write. Only an empty
// envelope, a queued async task, a failed status, or an error field means "not done".
function assertNotionWriteAccepted(envelope: z.infer<typeof toolResultSchema>): void {
  const payload = normalizedNotionPayload(envelope).value;
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  if (
    envelope.structuredContent === undefined &&
    (envelope.content ?? []).every((block) => block.type !== "text" || !block.text) ||
    record.object === "async_task" ||
    record.async_task != null ||
    record.error != null ||
    (typeof record.status === "string" && record.status !== "succeeded")
  ) {
    throw new NotionToolResultError();
  }
}

function normalizedNotionPayload(
  result: z.infer<typeof toolResultSchema>,
): { value: unknown; truncated: boolean; sizeTruncated: boolean; providerTruncation?: boolean } {
  if (result.structuredContent !== undefined) {
    const providerTruncation = notionPayloadTruncated(result.structuredContent);
    return {
      value: result.structuredContent,
      truncated: providerTruncation === true,
      sizeTruncated: false,
      ...(providerTruncation === undefined ? {} : { providerTruncation }),
    };
  }
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && block.text !== undefined)
    .map((block) => block.text)
    .join("\n");
  const bounded = truncateUtf8(text, maximumResultBytes);
  let value: unknown;
  try {
    value = JSON.parse(bounded.value) as unknown;
  } catch {
    return { value: bounded.value, truncated: bounded.truncated, sizeTruncated: bounded.truncated };
  }
  const providerTruncation = notionPayloadTruncated(value);
  return {
    value,
    truncated: bounded.truncated || providerTruncation === true,
    sizeTruncated: bounded.truncated,
    ...(providerTruncation === undefined ? {} : { providerTruncation }),
  };
}

function notionPayloadTruncated(value: unknown): boolean | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("truncated" in value)
  ) {
    return undefined;
  }
  return z.boolean().parse(value.truncated);
}


function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) {
    return { value, truncated: false };
  }
  let end = maximumBytes;
  for (;;) {
    const byte = encoded[end];
    if (end === 0 || byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    end -= 1;
  }
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}
