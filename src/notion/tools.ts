import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentRunStore } from "../agent/store.js";
import type { RegisteredTool, ToolExecutionContext } from "../agent/tools.js";
import type { ConnectionRouter } from "../connections/router.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionCapability, ConnectionRecord } from "../connections/types.js";
import { ModelSafeError } from "../core/errors.js";
import type { TraceId, WriteIntentId } from "../core/ids.js";
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
    properties: propertiesSchema,
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
    replaceAllMatches: z.boolean().default(false),
  })
  .strict();
const updateContentSchema = z
  .object({
    workspace: accountSchema,
    pageId: z.string().min(1).max(2_048),
    command: z.literal("update_content"),
    updates: z.array(contentUpdateSchema).min(1).max(20),
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
  readonly pageScopedSearches?: readonly {
    readonly pageId: string;
    readonly results: readonly NormalizedNotionReference[];
    readonly truncated: false;
  }[];
}

interface NormalizedNotionTextResult {
  readonly text: string;
  readonly truncated: boolean;
}

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
          description: "Search internal content in one connected Notion workspace. For automatic multi-account reads, call once per exact safe label in connected account status. When an incomplete result contains one exact title candidate, Annie performs a complete page-scoped search for that candidate. A truncated result without that scoped proof cannot establish an update target; narrow the query and search again.",
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
          description: "Update only a Notion page established by a complete same-run notion.search, including a complete page-scoped search added by Annie, and then fetched in this run using the same workspace label. Property, full-content, and text replacements require the current request to name the page; checkbox requests may instead name one unambiguous task. One replacement may include unchanged context, but a checkbox request must change exactly one marker. Text alone does not update it. Moving, deleting, and archiving are unavailable.",
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
              newContent: { type: "string", maxLength: 48_000 },
              updates: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "object",
                  properties: {
                    oldText: { type: "string", minLength: 1, maxLength: 8_000 },
                    newText: { type: "string", maxLength: 8_000 },
                    replaceAllMatches: { type: "boolean", default: false },
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
        const initial = normalizeNotionResult(
          "notion-search",
          await session.call("notion-search", request),
          request,
        );
        if (!("results" in initial) || !initial.truncated) {
          return initial;
        }

        const queryTitle = notionSearchTitle(input.query);
        const candidates = initial.results.filter(
          (
            reference,
          ): reference is NormalizedNotionReference & { readonly id: string; readonly title: string } =>
            typeof reference.id === "string" &&
            typeof reference.title === "string" &&
            notionSearchTitle(reference.title) === queryTitle,
        );
        const candidate = candidates[0];
        if (queryTitle.length === 0 || candidates.length !== 1 || candidate === undefined) {
          return initial;
        }

        const scopedRequest = {
          query: input.query,
          query_type: "internal",
          page_url: candidate.id,
          page_size: 50,
        } as const;
        const scoped = normalizeNotionResult(
          "notion-search",
          await session.call("notion-search", scopedRequest),
          scopedRequest,
        );
        if (
          !("results" in scoped) ||
          scoped.truncated ||
          !scoped.results.some((reference) => reference.id === candidate.id)
        ) {
          return initial;
        }
        return {
          ...initial,
          pageScopedSearches: [
            {
              pageId: candidate.id,
              results: scoped.results,
              truncated: false,
            },
          ],
        };
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
  ): Promise<unknown> {
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
      capability: "notion.create_page",
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
  ): Promise<unknown> {
    const connection = this.#select("notion.update_page", input.workspace, context);
    const upstream = toUpdateArguments(input);
    return this.#write({
      connection,
      context,
      upstreamName: "notion-update-page",
      capability: "notion.update_page",
      writeKind: "notion_update_page",
      argumentsValue: upstream,
      safeSummary: {
        command: input.command,
        pageId: input.pageId,
      },
    });
  }

  async #write(input: {
    connection: ConnectionRecord;
    context: ToolExecutionContext;
    upstreamName: Extract<NotionUpstreamTool, "notion-create-pages" | "notion-update-page">;
    capability: Extract<ConnectionCapability, "notion.create_page" | "notion.update_page">;
    writeKind: "notion_create_page" | "notion_update_page";
    argumentsValue: Record<string, unknown>;
    safeSummary: unknown;
  }): Promise<unknown> {
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
        this.#beginWrite(write.id, input.context);
        try {
          const result = normalizeNotionResult(
            input.upstreamName,
            await session.call(input.upstreamName, input.argumentsValue),
            input.argumentsValue,
          );
          const normalized = {
            ok: true,
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

  #beginWrite(writeId: WriteIntentId, context: ToolExecutionContext): void {
    this.#writes.beginAttempt({
      writeId,
      traceId: context.traceId,
      ...(context.jobLease === undefined
        ? {}
        : {
            jobLease: {
              jobId: context.jobLease.jobId,
              leaseToken: context.jobLease.leaseToken,
              nowMs: Date.now(),
            },
          }),
    });
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

function notionSearchTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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
