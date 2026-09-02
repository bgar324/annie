import { z } from "zod";
import type { AgentRunStore } from "../agent/store.js";
import type { RegisteredTool, ToolExecutionContext } from "../agent/tools.js";
import type { ConnectionRouter } from "../connections/router.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionCapability, ConnectionRecord } from "../connections/types.js";
import { ModelSafeError } from "../core/errors.js";
import type { TraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { GmailClientProvider, GmailProviderResponse } from "./client.js";
import {
  normalizeGmailMetadata,
  normalizeGmailThread,
  parseGmailMessageList,
} from "./normalize.js";

const accountSchema = z.string().trim().min(1).max(160).optional();
const searchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    account: accountSchema,
    maxResults: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const readThreadArgumentsSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    account: accountSchema,
  })
  .strict();

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
          description: "Search one connected Gmail account. For automatic multi-account reads, call once per exact safe label returned by connections.list.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 512 },
              account: { type: "string", minLength: 1, maxLength: 160 },
              maxResults: { type: "integer", minimum: 1, maximum: 20, default: 10 },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        execute: async (argumentsValue, context) =>
          this.search(searchArgumentsSchema.parse(argumentsValue), context),
      },
      {
        definition: {
          name: "gmail.read_thread",
          description: "Read a bounded, normalized Gmail thread from the source account returned by gmail.search.",
          parameters: {
            type: "object",
            properties: {
              threadId: { type: "string", minLength: 1, maxLength: 256 },
              account: { type: "string", minLength: 1, maxLength: 160 },
            },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        execute: async (argumentsValue, context) =>
          this.readThread(readThreadArgumentsSchema.parse(argumentsValue), context),
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
    const listed = await this.#readRequest("messages.list", connection, context.traceId, () =>
      api.listMessages({
        query: input.query,
        maxResults: input.maxResults,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
    const list = parseGmailMessageList(listed.data);
    const messages = [];
    for (const item of list.messages) {
      const response = await this.#readRequest("messages.get", connection, context.traceId, () =>
        api.getMessage({
          messageId: item.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"],
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
      messages.push(normalizeGmailMetadata(response.data));
    }
    this.#markHealthy(connection, context.traceId);
    return {
      account: { label: connection.safeLabel },
      resultSizeEstimate: list.resultSizeEstimate,
      messages,
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
    const response = await this.#readRequest("threads.get", connection, context.traceId, () =>
      api.getThread({
        threadId: input.threadId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
    const thread = normalizeGmailThread(response.data);
    this.#markHealthy(connection, context.traceId);
    return {
      account: { label: connection.safeLabel },
      thread,
    };
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
    traceId: TraceId,
    request: () => Promise<GmailProviderResponse>,
  ): Promise<GmailProviderResponse> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.#traceRequest(traceId, operation, connection, "attempted", { attempt });
      try {
        const response = await request();
        this.#traceRequest(traceId, operation, connection, "succeeded", {
          attempt,
          providerRequestId: providerRequestId(response.headers),
        });
        return response;
      } catch (error) {
        const status = providerStatus(error);
        const retryable = status === null || status === 429 || status === 500 || status === 503;
        const retryAfterMs = retryable ? gmailRetryDelay(error, attempt) : null;
        this.#traceRequest(traceId, operation, connection, "failed", {
          attempt,
          status,
          retryable,
          retryAfterMs,
        });
        if (retryable && attempt < 3) {
          await this.#sleep(retryAfterMs ?? attempt * 250);
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
    operation: string,
    connection: ConnectionRecord,
    event: "attempted" | "succeeded" | "failed",
    data: Record<string, unknown>,
  ): void {
    this.#traces.append({
      traceId,
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

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
