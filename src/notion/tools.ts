import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentRunStore } from "../agent/store.js";
import type { RegisteredTool, ToolExecutionContext } from "../agent/tools.js";
import type { ConnectionRouter } from "../connections/router.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionCapability, ConnectionRecord } from "../connections/types.js";
import { ModelSafeError } from "../core/errors.js";
import type { TraceId } from "../core/ids.js";
import type { WriteStore } from "../writes/store.js";
import type { NotionClientProvider, NotionUpstreamTool } from "./client.js";

const accountSchema = z.string().trim().min(1).max(160).optional();
const searchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    workspace: accountSchema,
    pageSize: z.number().int().min(1).max(10).default(10),
  })
  .strict();
const upstreamSearchArgumentsSchema = z
  .object({ page_size: z.number().int().min(1).max(50) })
  .loose();
const fetchArgumentsSchema = z
  .object({
    id: z.string().trim().min(1).max(2_048),
    workspace: accountSchema,
  })
  .strict();
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
const updatePageArgumentsSchema = z.discriminatedUnion("command", [
  updatePropertiesSchema,
  replaceContentSchema,
  updateContentSchema,
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
    }
  | {
      ok: true;
      outcome: "unchanged";
      workspace: { label: string };
      result: { pageId: string };
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
const notionUpdateRequestSchema = z.object({ page_id: z.string().min(1).max(2_048) }).loose();
const notionUpdateResponseSchema = z
  .object({
    id: z.string().min(1).max(2_048).optional(),
    page_id: z.string().min(1).max(2_048).optional(),
    truncated: z.boolean(),
  })
  .loose()
  .refine((value) => value.id !== undefined || value.page_id !== undefined);

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
          description: "Search internal content in one connected Notion workspace. For automatic multi-account reads, call once per exact safe label in connected account status. Search finds candidate pages; fetch the selected page before editing it.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 512 },
              workspace: { type: "string", minLength: 1, maxLength: 160 },
              pageSize: { type: "integer", minimum: 1, maximum: 10, default: 10 },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        batchMode: "parallel_read",
        execute: async (argumentsValue, context) =>
          this.search(searchArgumentsSchema.parse(argumentsValue), context),
      },
      {
        definition: {
          name: "notion.fetch",
          description: "Fetch a Notion page, database, data source, view, or block from the source workspace returned by notion.search.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 2_048 },
              workspace: { type: "string", minLength: 1, maxLength: 160 },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        batchMode: "parallel_read",
        execute: async (argumentsValue, context) =>
          this.fetch(fetchArgumentsSchema.parse(argumentsValue), context),
      },
      {
        definition: {
          name: "notion.create_page",
          description: "Create one Notion page with narrow properties and optional text. Text alone does not create it.",
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
          this.createPage(createPageArgumentsSchema.parse(argumentsValue), context),
      },
      {
        definition: {
          name: "notion.update_page",
          description: "Update one page fetched in this run using the same workspace. Use one unique exact-text patch for task changes or additions, one property for a property change, or replace_content only when the user requests a full rewrite. Include unchanged headings/context to distinguish repeated text. An unchanged patch returns outcome:unchanged without a provider write. Moving, deleting, and archiving are unavailable.",
          parameters: {
            type: "object",
            properties: {
              workspace: { type: "string", minLength: 1, maxLength: 160 },
              pageId: { type: "string", minLength: 1, maxLength: 2_048 },
              command: {
                enum: ["update_properties", "replace_content", "update_content"],
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
            },
            required: ["workspace", "pageId", "command"],
            allOf: [
              {
                if: { properties: { command: { const: "update_properties" } } },
                then: {
                  properties: { properties: { type: "object" } },
                  required: ["properties"],
                },
              },
              {
                if: { properties: { command: { const: "replace_content" } } },
                then: {
                  properties: { newContent: { type: "string" } },
                  required: ["newContent"],
                },
              },
              {
                if: { properties: { command: { const: "update_content" } } },
                then: {
                  properties: { updates: { type: "array" } },
                  required: ["updates"],
                },
              },
            ],
            additionalProperties: false,
          },
        },
        operationClass: "write",
        execute: async (argumentsValue, context) =>
          this.updatePage(updatePageArgumentsSchema.parse(argumentsValue), context),
      },
    ];
  }

  async search(
    input: z.infer<typeof searchArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const connection = this.#select("notion.search", input.workspace, context);
    const result = await this.#clients.withSession(
      connection.id,
      context.traceId,
      async (session) => {
        const request = {
          query: input.query,
          query_type: "internal",
          page_size: input.pageSize,
        } as const;
        return normalizeNotionResult(
          "notion-search",
          await session.call("notion-search", request),
          request,
        );
      },
      context.signal,
    );
    this.#markHealthy(connection, context.traceId);
    return { workspace: { label: connection.safeLabel }, result };
  }

  async fetch(
    input: z.infer<typeof fetchArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const connection = this.#select("notion.fetch", input.workspace, context);
    const result = await this.#clients.withSession(connection.id, context.traceId, async (session) =>
      normalizeNotionResult(
        "notion-fetch",
        await session.call("notion-fetch", { id: input.id }),
      ),
      context.signal,
    );
    this.#markHealthy(connection, context.traceId);
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
    let unchanged = false;
    if (input.command === "update_content") {
      const [update] = input.updates;
      const offset = page.text?.indexOf(update.oldText) ?? -1;
      if (
        offset < 0 ||
        page.text?.indexOf(update.oldText, offset + 1) !== -1
      ) {
        throw new ModelSafeError(
          "NotionWriteTargetError",
          "write_target_ambiguous",
          "The old text must occur exactly once in the fetched page. Fetch again and include enough unchanged context to identify one location.",
        );
      }
      unchanged = update.oldText === update.newText;
    } else if (input.command === "replace_content") {
      if (page.text === undefined) {
        throw new ModelSafeError(
          "NotionWriteTargetError",
          "write_target_unverified",
          "Fetch the complete page text before replacing its content.",
        );
      }
      unchanged = input.newContent === page.text;
    }
    if (unchanged) {
      return {
        ok: true,
        outcome: "unchanged",
        workspace: { label: connection.safeLabel },
        result: { pageId: input.pageId },
      };
    }
    return this.#write({
      connection,
      context,
      upstreamName: "notion-update-page",
      writeKind: "notion_update_page",
      argumentsValue: toUpdateArguments(input),
      safeSummary: {
        command: input.command,
        pageId: input.pageId,
      },
    });
  }

  #fetchedPage(
    pageId: string,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): z.infer<typeof fetchedPageSchema>["result"] {
    const row = this.#db
      .prepare<
        { run_id: string; connection_id: string; page_id: string },
        { result_json: string }
      >(`
        SELECT result_json FROM tool_executions
        WHERE run_id = @run_id AND connection_id = @connection_id
          AND tool_name = 'notion.fetch' AND status = 'succeeded'
          AND json_extract(arguments_json, '$.id') = @page_id
          AND result_json IS NOT NULL
        ORDER BY rowid DESC
        LIMIT 1
      `)
      .get({
        run_id: context.runId,
        connection_id: connection.id,
        page_id: pageId,
      });
    const fetched = fetchedPageSchema.safeParse(
      row === undefined ? undefined : JSON.parse(row.result_json),
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
            result,
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
    super("NotionToolResultError", "provider_rejected", "Notion rejected the tool call");
  }
}

function toUpdateArguments(
  input: z.infer<typeof updatePageArgumentsSchema>,
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

function normalizeNotionResult(
  name: "notion-search",
  raw: unknown,
  argumentsValue: Record<string, unknown>,
): NormalizedNotionSearchResult | NormalizedNotionTextResult;
function normalizeNotionResult(
  name: Exclude<NotionUpstreamTool, "notion-search">,
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
    const request = notionUpdateRequestSchema.parse(argumentsValue);
    const payload = normalizedNotionPayload(envelope);
    const response = notionUpdateResponseSchema.parse(payload.value);
    if (
      payload.truncated ||
      (response.id !== undefined && response.id !== request.page_id) ||
      (response.page_id !== undefined && response.page_id !== request.page_id)
    ) {
      throw new NotionToolResultError();
    }
    return { pageId: request.page_id, updated: true };
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
  if (name === "notion-fetch") {
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

  const parsed = notionCreateResultSchema.parse(payload.value);
  const pages =
    parsed.pages ??
    (parsed.id === undefined
      ? []
      : [{ id: parsed.id, ...(parsed.url === undefined ? {} : { url: parsed.url }) }]);
  return {
    pages: pages.map((page) => ({
      id: page.id,
      ...(page.title === undefined ? {} : { title: page.title }),
      ...(page.url === undefined ? {} : { url: page.url }),
    })),
  };
}

function normalizedNotionPayload(
  result: z.infer<typeof toolResultSchema>,
): { value: unknown; truncated: boolean; providerTruncation?: boolean } {
  if (result.structuredContent !== undefined) {
    const providerTruncation = notionPayloadTruncated(result.structuredContent);
    return {
      value: result.structuredContent,
      truncated: providerTruncation === true,
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
    return { value: bounded.value, truncated: bounded.truncated };
  }
  const providerTruncation = notionPayloadTruncated(value);
  return {
    value,
    truncated: bounded.truncated || providerTruncation === true,
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
