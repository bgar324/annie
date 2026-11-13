import { z } from "zod";
import type { AgentRunStore } from "../agent/store.js";
import { parseToolArguments, type RegisteredTool, type ToolExecutionContext } from "../agent/tools.js";
import type { ConnectionRouter } from "../connections/router.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionCapability, ConnectionRecord } from "../connections/types.js";
import { ModelSafeError } from "../core/errors.js";
import type { ToolExecutionId, TraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { GmailApi, GmailClientProvider, GmailProviderResponse } from "./client.js";
import {
  findGmailAttachment,
  fullGmailThreadBounds,
  hydratedGmailThreadBounds,
  normalizeGmailMetadata,
  normalizeGmailThread,
  parseGmailMessageList,
  type NormalizedGmailMessage,
  type NormalizedGmailThread,
} from "./normalize.js";
import { extractPdfText } from "./pdf.js";
import { PDF_MAX_BYTES } from "./pdf-protocol.js";

const accountSchema = z.string().trim().min(1).max(160).optional();
const searchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    account: accountSchema,
    maxResults: z.number().int().min(1).optional(),
    hydrateThreads: z.number().int().min(0).max(3).optional(),
  })
  .strict();
const readThreadArgumentsSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    account: accountSchema,
    attachment: z.object({
      messageId: z.string().min(1).max(512),
      filename: z.string().min(1).max(256),
    }).strict().optional(),
  })
  .strict();
const maximumSearchResultBytes = 120 * 1_024;
const maximumHydrationBytes = 24 * 1_024;

interface HydratedThread {
  readonly threadId: string;
  readonly thread: NormalizedGmailThread;
}

interface SearchHydration {
  readonly requested: number;
  readonly truncated: boolean;
  readonly threads: readonly HydratedThread[];
}

export class GmailToolService {
  readonly #router: ConnectionRouter;
  readonly #connections: ConnectionStore;
  readonly #clients: GmailClientProvider;
  readonly #runs: AgentRunStore;
  readonly #traces: TraceStore;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    router: ConnectionRouter;
    connections: ConnectionStore;
    clients: GmailClientProvider;
    runs: AgentRunStore;
    traces: TraceStore;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#router = input.router;
    this.#connections = input.connections;
    this.#clients = input.clients;
    this.#runs = input.runs;
    this.#traces = input.traces;
    this.#sleep = input.sleep ?? delay;
  }

  tools(): readonly RegisteredTool[] {
    return [
      {
        definition: {
          name: "gmail.search",
          description: "Search one connected Gmail account. Omit maxResults to retrieve all matching messages within the result byte budget; set it only for an intentional total limit. For automatic multi-account reads, call once per exact safe label in connected account status. Set hydrateThreads to 1-3 only for a targeted query that needs the top matching thread contents; each hydrated thread is strictly bounded.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 512 },
              account: { type: "string", minLength: 1, maxLength: 160 },
              maxResults: {
                type: "integer",
                minimum: 1,
                description: "Optional total message limit. Omit to retrieve all matching pages within the result byte budget.",
              },
              hydrateThreads: {
                type: "integer",
                minimum: 0,
                maximum: 3,
                default: 0,
                description:
                  "Include bounded contents for up to this many top distinct threads. Use only when the request needs message contents.",
              },
            },
            required: ["query"],
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
          name: "gmail.read_thread",
          description: "Read a bounded Gmail thread from the source account. To read a PDF listed in that thread or search hydration, set attachment to its exact message id and filename. Returns extracted text, truncation, or an explicit limitation; no OCR for scanned pages.",
          parameters: {
            type: "object",
            properties: {
              threadId: { type: "string", minLength: 1, maxLength: 256 },
              account: { type: "string", minLength: 1, maxLength: 160 },
              attachment: {
                type: "object",
                properties: {
                  messageId: { type: "string", minLength: 1, maxLength: 512 },
                  filename: { type: "string", minLength: 1, maxLength: 256 },
                },
                required: ["messageId", "filename"],
                additionalProperties: false,
              },
            },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        batchMode: "parallel_read",
        execute: async (argumentsValue, context) =>
          this.readThread(parseToolArguments(readThreadArgumentsSchema, argumentsValue), context),
      },
    ];
  }

  async search(
    input: z.infer<typeof searchArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const selected = this.#select("gmail.read", input.account, context);
    const api = await this.#clients.forConnection(selected.id, context.traceId, context.signal);
    const connection = this.#router.select({
      capabilities: ["gmail.read"],
      connectionId: selected.id,
    });
    const messages: NormalizedGmailMessage[] = [];
    const hydrationMessages: { id: string; threadId: string | null }[] = [];
    const seenMessageIds = new Set<string>();
    const seenPageTokens = new Set<string>();
    const requestedHydration = input.hydrateThreads ?? 0;
    const emptyHydration: SearchHydration | undefined = requestedHydration === 0
      ? undefined
      : { requested: requestedHydration, truncated: false, threads: [] };
    let resultSizeEstimate: number | null = null;
    let serializedBytes = Buffer.byteLength(JSON.stringify({
      account: { label: connection.safeLabel },
      resultSizeEstimate,
      messages,
      messagesTruncated: false,
      ...(emptyHydration === undefined ? {} : { hydration: emptyHydration }),
    }));
    let messagesTruncated = false;
    let pageToken: string | undefined;
    let firstPage = true;
    pages: for (;;) {
      const remaining = input.maxResults === undefined
        ? 500
        : input.maxResults - messages.length;
      const listed = await this.#readRequest("messages.list", connection, context, () =>
        api.listMessages({
          query: input.query,
          maxResults: Math.min(500, remaining),
          ...(pageToken === undefined ? {} : { pageToken }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
      context.signal?.throwIfAborted();
      const list = parseGmailMessageList(listed.data);
      if (firstPage) {
        resultSizeEstimate = list.resultSizeEstimate;
        serializedBytes += Buffer.byteLength(JSON.stringify(resultSizeEstimate)) - 4;
        firstPage = false;
      }
      const uniqueMessages = list.messages.filter((message) => {
        if (seenMessageIds.has(message.id)) {
          return false;
        }
        seenMessageIds.add(message.id);
        return true;
      });
      const pageMessages = uniqueMessages.slice(0, remaining);
      for (let index = 0; index < pageMessages.length; index += 5) {
        const wave = pageMessages.slice(index, index + 5);
        const metadata = await mapInWaves(wave, 5, async (item) => {
          const response = await this.#readRequest("messages.get", connection, context, () =>
            api.getMessage({
              messageId: item.id,
              format: "metadata",
              metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"],
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          );
          return { listed: item, message: normalizeGmailMetadata(response.data) };
        });
        context.signal?.throwIfAborted();
        for (const item of metadata) {
          const messageBytes = Buffer.byteLength(JSON.stringify(item.message));
          const separatorBytes = messages.length === 0 ? 0 : 1;
          if (serializedBytes + separatorBytes + messageBytes > maximumSearchResultBytes) {
            messagesTruncated = true;
            break pages;
          }
          messages.push(item.message);
          if (requestedHydration > 0) {
            hydrationMessages.push(item.listed);
          }
          serializedBytes += separatorBytes + messageBytes;
        }
      }
      if (uniqueMessages.length > pageMessages.length) {
        messagesTruncated = true;
        break;
      }
      if (list.nextPageToken === null) {
        break;
      }
      if (
        messages.length === input.maxResults ||
        seenPageTokens.has(list.nextPageToken)
      ) {
        messagesTruncated = true;
        break;
      }
      pageToken = list.nextPageToken;
      seenPageTokens.add(pageToken);
    }
    const hydration = emptyHydration === undefined
      ? undefined
      : await this.#hydrateThreads(
          hydrationMessages,
          requestedHydration,
          api,
          connection,
          context,
          Math.min(
            maximumHydrationBytes,
            maximumSearchResultBytes - serializedBytes +
              Buffer.byteLength(JSON.stringify(emptyHydration)),
          ),
        );
    context.signal?.throwIfAborted();
    this.#markHealthy(connection, context.traceId);
    return {
      account: { label: connection.safeLabel },
      resultSizeEstimate,
      messagesTruncated,
      messages,
      ...(hydration === undefined ? {} : { hydration }),
    };
  }

  async readThread(
    input: z.infer<typeof readThreadArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const selected = this.#select("gmail.read", input.account, context);
    const api = await this.#clients.forConnection(selected.id, context.traceId, context.signal);
    const connection = this.#router.select({
      capabilities: ["gmail.read"],
      connectionId: selected.id,
    });
    const response = await this.#readRequest("threads.get", connection, context, () =>
      api.getThread({
        threadId: input.threadId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
    // Reserve room for 32 KiB of PDF text, including worst-case JSON escaping, under
    // the agent's 128 KiB per-result cap. Ordinary thread reads retain their full bounds.
    const thread = normalizeGmailThread(response.data, input.attachment === undefined
      ? fullGmailThreadBounds
      : { ...fullGmailThreadBounds, maximumThreadBytes: 48 * 1_024, maximumBodyBytes: 32 * 1_024 });
    this.#markHealthy(connection, context.traceId);
    return {
      account: { label: connection.safeLabel },
      thread,
      ...(input.attachment === undefined ? {} : {
        attachment: await this.#readPdfAttachment(
          response.data, { threadId: input.threadId, ...input.attachment }, api, connection, context,
        ),
      }),
    };
  }

  async #readPdfAttachment(
    threadData: unknown,
    selector: { threadId: string; messageId: string; filename: string },
    api: GmailApi,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ) {
    const identity = { messageId: selector.messageId, filename: selector.filename };
    const part = findGmailAttachment(threadData, selector);
    if (part === null) {
      return {
        ...identity, status: "unavailable", reason: "attachment_not_found",
        message: "No unique attachment with that exact filename exists in the selected message and thread.",
      };
    }
    const mimeType = (part.mimeType ?? "").toLowerCase();
    if (mimeType !== "application/pdf" &&
        !(mimeType === "application/octet-stream" && /\.pdf$/iu.test(selector.filename))) {
      return {
        ...identity, status: "unavailable", reason: "unsupported_type",
        message: "Only PDF attachments can be read.",
      };
    }
    if ((part.body?.size ?? 0) > PDF_MAX_BYTES) {
      return {
        ...identity, status: "unavailable", reason: "too_large",
        message: "PDF attachments must be no larger than 5 MiB.",
      };
    }
    let body: unknown = part.body;
    const attachmentId = part.body?.attachmentId;
    if (part.body?.data === undefined && attachmentId !== undefined) {
      const response = await this.#readRequest("messages.attachments.get", connection, context, () =>
        api.getAttachment({
          messageId: selector.messageId,
          attachmentId,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
      body = response.data;
    }
    const parsed = z.object({
      size: z.number().int().nonnegative().optional(),
      data: z.string(),
    }).safeParse(body);
    if (!parsed.success || !/^[A-Za-z0-9_-]*={0,2}$/u.test(parsed.data.data)) {
      return {
        ...identity, status: "unavailable", reason: "invalid_data",
        message: "Gmail returned invalid attachment data; its contents were not read.",
      };
    }
    if ((parsed.data.size ?? 0) > PDF_MAX_BYTES ||
        parsed.data.data.length > Math.ceil(PDF_MAX_BYTES / 3) * 4) {
      return {
        ...identity, status: "unavailable", reason: "too_large",
        message: "PDF attachments must be no larger than 5 MiB.",
      };
    }
    const bytes = Buffer.from(parsed.data.data, "base64url");
    if (bytes.length > PDF_MAX_BYTES) {
      return {
        ...identity, status: "unavailable", reason: "too_large",
        message: "PDF attachments must be no larger than 5 MiB.",
      };
    }
    if ((parsed.data.size !== undefined && parsed.data.size !== bytes.length) ||
        (part.body?.size !== undefined && part.body.size !== bytes.length)) {
      return {
        ...identity, status: "unavailable", reason: "invalid_data",
        message: "The attachment size did not match Gmail's metadata; its contents were not read.",
      };
    }
    context.signal?.throwIfAborted();
    return { ...identity, mimeType: "application/pdf", ...await extractPdfText(bytes, context.signal) };
  }

  async #hydrateThreads(
    messages: readonly { id: string; threadId: string | null }[],
    requested: number,
    api: Awaited<ReturnType<GmailClientProvider["forConnection"]>>,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
    maximumBytes: number,
  ): Promise<SearchHydration> {
    const threadIds: string[] = [];
    for (const message of messages) {
      if (
        message.threadId !== null &&
        !threadIds.includes(message.threadId) &&
        threadIds.length < requested
      ) {
        threadIds.push(message.threadId);
      }
    }
    const normalized = await mapInWaves(threadIds, 3, async (threadId) => {
      try {
        const response = await this.#readRequest("threads.get", connection, context, () =>
          api.getThread({
            threadId,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          }),
        );
        return {
          threadId,
          thread: normalizeGmailThread(response.data, hydratedGmailThreadBounds),
        };
      } catch (error) {
        context.signal?.throwIfAborted();
        this.#traces.append({
          traceId: context.traceId,
          component: "gmail",
          event: "hydration_skipped",
          outcome: error instanceof Error ? error.name : "UnknownError",
          runId: context.runId,
          toolExecutionId: context.toolExecutionId,
          data: { threadId },
        });
        return undefined;
      }
    });
    const threads: HydratedThread[] = [];
    let serializedBytes = Buffer.byteLength(
      JSON.stringify({ requested, truncated: false, threads: [] }),
    );
    let truncated = false;
    for (const item of normalized) {
      if (item === undefined) {
        truncated = true;
        continue;
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      const separatorBytes = threads.length === 0 ? 0 : 1;
      if (serializedBytes + separatorBytes + itemBytes > maximumBytes) {
        truncated = true;
        continue;
      }
      serializedBytes += separatorBytes + itemBytes;
      threads.push(item);
      truncated ||= item.thread.messagesTruncated;
    }
    return { requested, truncated, threads };
  }

  #select(
    capability: ConnectionCapability,
    account: string | undefined,
    context: ToolExecutionContext,
  ): ConnectionRecord {
    const connection = this.#router.select({
      capabilities: [capability],
      ...(context.connectionId === null
        ? account === undefined
          ? {}
          : { account }
        : { connectionId: context.connectionId }),
    });
    this.#runs.bindToolConnection(context.toolExecutionId, connection.id);
    return connection;
  }

  async #readRequest(
    operation: string,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
    request: () => Promise<GmailProviderResponse>,
  ): Promise<GmailProviderResponse> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      context.signal?.throwIfAborted();
      this.#traceRequest(context.traceId, context.toolExecutionId, operation, connection, "attempted", { attempt });
      try {
        const response = await request();
        this.#traceRequest(context.traceId, context.toolExecutionId, operation, connection, "succeeded", {
          attempt,
          providerRequestId: providerRequestId(response.headers),
        });
        return response;
      } catch (error) {
        const status = providerStatus(error);
        const retryable = status === null || status === 429 || status === 500 || status === 503;
        const retryAfterMs = retryable ? gmailRetryDelay(error, attempt) : null;
        this.#traceRequest(context.traceId, context.toolExecutionId, operation, connection, "failed", {
          attempt,
          status,
          retryable,
          retryAfterMs,
        });
        context.signal?.throwIfAborted();
        if (retryable && attempt < 3) {
          await this.#sleep(retryAfterMs ?? attempt * 250);
          context.signal?.throwIfAborted();
          continue;
        }
        throw new GmailToolError(
          status === 429 ? "rate_limited" : "provider_read_failed",
          `Gmail ${operation} failed${status === null ? "" : ` with HTTP ${status}`}`,
          { cause: error },
        );
      }
    }
    throw new Error("Unreachable Gmail read retry state");
  }

  #markHealthy(connection: ConnectionRecord, traceId: TraceId): void {
    this.#connections.markHealthy({
      connectionId: connection.id,
      credentialGeneration: connection.credentialGeneration,
      traceId,
    });
  }

  #traceRequest(
    traceId: TraceId,
    toolExecutionId: ToolExecutionId,
    operation: string,
    connection: ConnectionRecord,
    event: "attempted" | "succeeded" | "failed",
    data: Record<string, unknown>,
  ): void {
    this.#traces.append({
      traceId,
      toolExecutionId,
      component: "gmail",
      event: `request_${event}`,
      outcome: operation,
      ...(typeof data.providerRequestId === "string"
        ? { providerRequestId: data.providerRequestId }
        : {}),
      data: {
        operation,
        connectionId: connection.id,
        credentialGeneration: connection.credentialGeneration,
        ...data,
      },
    });
  }
}

type GmailToolErrorCode = "rate_limited" | "provider_read_failed";

export class GmailToolError extends ModelSafeError<GmailToolErrorCode> {
  constructor(code: GmailToolErrorCode, message: string, options?: ErrorOptions) {
    super("GmailToolError", code, message, options);
  }
}

function providerStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return null;
  }
  const response = error.response;
  if (typeof response !== "object" || response === null || !("status" in response)) {
    return null;
  }
  return typeof response.status === "number" ? response.status : null;
}

function providerRequestId(headers: unknown): string | undefined {
  for (const name of ["x-request-id", "x-guploader-uploadid"] as const) {
    const value = headerValue(headers, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function gmailRetryDelay(error: unknown, attempt: number): number {
  if (providerStatus(error) !== 429 || typeof error !== "object" || error === null) {
    return attempt * 250;
  }
  const headers = "response" in error && typeof error.response === "object" && error.response !== null
    ? Reflect.get(error.response, "headers")
    : undefined;
  const value = headerValue(headers, "retry-after");
  if (value === undefined) {
    return attempt * 250;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(5_000, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(5_000, Math.max(0, date - Date.now())) : attempt * 250;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const getter = Reflect.get(headers, "get");
  if (typeof getter === "function") {
    const value = Reflect.apply(getter, headers, [name]) as unknown;
    return typeof value === "string" ? value : undefined;
  }
  const value = Reflect.get(headers, name) ?? Reflect.get(headers, name.toLowerCase());
  return typeof value === "string" ? value : undefined;
}


async function mapInWaves<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    const settled = await Promise.allSettled(items.slice(index, index + limit).map(worker));
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
    results.push(
      ...settled.map((result) => (result as PromiseFulfilledResult<R>).value),
    );
  }
  return results;
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
