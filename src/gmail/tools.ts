import type Database from "better-sqlite3";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import type { AgentRunStore } from "../agent/store.js";
import type { RegisteredTool, ToolExecutionContext } from "../agent/tools.js";
import type { RuntimeConfig } from "../config.js";
import type { ConnectionRouter } from "../connections/router.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionRecord, ToolCapability } from "../connections/types.js";
import { ModelSafeError } from "../core/errors.js";
import type { TraceId, WriteIntentId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { WriteStore } from "../writes/store.js";
import type { GmailApi, GmailClientProvider, GmailProviderResponse } from "./client.js";
import {
  normalizeGmailMetadata,
  normalizeGmailThread,
  parseCreatedDraft,
  parseGmailMessageList,
  parseSentMessage,
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
const emailAddressSchema = z.string().email().max(320);
const createDraftArgumentsSchema = z
  .object({
    account: accountSchema,
    to: z.array(emailAddressSchema).min(1).max(20),
    cc: z.array(emailAddressSchema).max(20).optional(),
    bcc: z.array(emailAddressSchema).max(20).optional(),
    subject: z.string().max(998),
    bodyText: z.string().min(1).max(48_000),
    bodyHtml: z.string().max(48_000).optional(),
    threadId: z.string().min(1).max(256).optional(),
    replyToMessageId: z.string().min(3).max(998).optional(),
  })
  .strict();
const sendDraftArgumentsSchema = z
  .object({
    account: accountSchema,
    draftId: z.string().min(1).max(256),
  })
  .strict();
const draftWriteRequestSchema = z
  .object({
    raw: z.string().min(1).max(262_144),
    threadId: z.string().min(1).max(256).optional(),
    rfcMessageId: z.string().min(3).max(998),
  })
  .strict();

interface DraftRow {
  provider_draft_id: string;
  rfc_message_id: string;
  status: "draft" | "send_attempting" | "sent" | "ambiguous";
}

export class GmailToolService {
  readonly #db: Database.Database;
  readonly #config: RuntimeConfig;
  readonly #router: ConnectionRouter;
  readonly #connections: ConnectionStore;
  readonly #clients: GmailClientProvider;
  readonly #runs: AgentRunStore;
  readonly #writes: WriteStore;
  readonly #traces: TraceStore;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    db: Database.Database;
    config: RuntimeConfig;
    router: ConnectionRouter;
    connections: ConnectionStore;
    clients: GmailClientProvider;
    runs: AgentRunStore;
    writes: WriteStore;
    traces: TraceStore;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#db = input.db;
    this.#config = input.config;
    this.#router = input.router;
    this.#connections = input.connections;
    this.#clients = input.clients;
    this.#runs = input.runs;
    this.#writes = input.writes;
    this.#traces = input.traces;
    this.#sleep = input.sleep ?? delay;
  }

  tools(): readonly RegisteredTool[] {
    return [
      {
        definition: {
          name: "gmail.search",
          description: "Search one connected Gmail account. Specify account when more than one account is connected.",
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
          description: "Read a bounded, normalized Gmail thread from one connected account.",
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
      {
        definition: {
          name: "gmail.create_draft",
          description: "Create, but do not send, an email draft in one connected Gmail account.",
          parameters: {
            type: "object",
            properties: {
              account: { type: "string", minLength: 1, maxLength: 160 },
              to: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
              cc: { type: "array", maxItems: 20, items: { type: "string" } },
              bcc: { type: "array", maxItems: 20, items: { type: "string" } },
              subject: { type: "string", maxLength: 998 },
              bodyText: { type: "string", minLength: 1, maxLength: 48_000 },
              bodyHtml: { type: "string", maxLength: 48_000 },
              threadId: { type: "string", minLength: 1, maxLength: 256 },
              replyToMessageId: { type: "string", minLength: 3, maxLength: 998 },
            },
            required: ["to", "subject", "bodyText"],
            additionalProperties: false,
          },
        },
        operationClass: "write",
        execute: async (argumentsValue, context) =>
          this.createDraft(createDraftArgumentsSchema.parse(argumentsValue), context),
      },
      {
        definition: {
          name: "gmail.send_draft",
          description: "Send a draft previously created by this assistant. This cannot send arbitrary provider drafts.",
          parameters: {
            type: "object",
            properties: {
              account: { type: "string", minLength: 1, maxLength: 160 },
              draftId: { type: "string", minLength: 1, maxLength: 256 },
            },
            required: ["draftId"],
            additionalProperties: false,
          },
        },
        operationClass: "write",
        execute: async (argumentsValue, context) =>
          this.sendDraft(sendDraftArgumentsSchema.parse(argumentsValue), context),
      },
    ];
  }

  async search(
    input: z.infer<typeof searchArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const connection = this.#select("gmail.search", input.account, context);
    const api = await this.#clients.forConnection(connection.id, context.traceId, context.signal);
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
    const connection = this.#select("gmail.read_thread", input.account, context);
    const api = await this.#clients.forConnection(connection.id, context.traceId, context.signal);
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

  async createDraft(
    input: z.infer<typeof createDraftArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const connection = this.#select("gmail.create_draft", input.account, context);
    const prepared = this.#writes.getByToolExecution(context.toolExecutionId);
    const newRfcMessageId = `<${context.toolExecutionId}@${new URL(this.#config.publicBaseUrl).hostname}>`;
    const request =
      prepared === undefined
        ? {
            raw: (await composeMessage(input, connection, newRfcMessageId)).toString("base64url"),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            rfcMessageId: newRfcMessageId,
          }
        : draftWriteRequestSchema.parse(prepared.request);
    const rfcMessageId = request.rfcMessageId;
    const api = await this.#clients.forConnection(connection.id, context.traceId, context.signal);
    const write = this.#writes.prepare({
      traceId: context.traceId,
      runId: context.runId,
      toolExecutionId: context.toolExecutionId,
      connectionId: connection.id,
      connectionGeneration: connection.credentialGeneration,
      kind: "gmail_create_draft",
      request,
      safeSummary: {
        recipientCount: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
        bodyBytes: Buffer.byteLength(input.bodyText) + Buffer.byteLength(input.bodyHtml ?? ""),
      },
    });
    this.#beginWrite(write.id, context);
    try {
      const response = await this.#writeRequest("drafts.create", connection, context.traceId, () =>
        api.createDraft({
          raw: request.raw,
          ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
      const created = parseCreatedDraft(response.data);
      const result = {
        ok: true,
        account: { label: connection.safeLabel },
        ...created,
        rfcMessageId,
      };
      const transaction = this.#db.transaction(() => {
        this.#writes.completeInTransaction({
          writeId: write.id,
          traceId: context.traceId,
          state: "succeeded",
          normalizedResult: result,
          providerReference: created,
        });
        this.#db
          .prepare<{
            connection_id: string;
            provider_draft_id: string;
            provider_message_id: string | null;
            provider_thread_id: string | null;
            rfc_message_id: string;
            safe_summary_json: string;
            now_ms: number;
          }>(`
            INSERT INTO gmail_drafts(
              connection_id, provider_draft_id, provider_message_id, provider_thread_id,
              rfc_message_id, status, safe_summary_json, sent_message_id,
              created_at_ms, updated_at_ms
            ) VALUES (
              @connection_id, @provider_draft_id, @provider_message_id, @provider_thread_id,
              @rfc_message_id, 'draft', @safe_summary_json, NULL, @now_ms, @now_ms
            )
          `)
          .run({
            connection_id: connection.id,
            provider_draft_id: created.draftId,
            provider_message_id: created.messageId,
            provider_thread_id: created.threadId,
            rfc_message_id: rfcMessageId,
            safe_summary_json: JSON.stringify({ recipientCount: input.to.length }),
            now_ms: Date.now(),
          });
      });
      transaction.immediate();
      this.#markHealthy(connection, context.traceId);
      return result;
    } catch (error) {
      if (this.#writes.get(write.id)?.state === "attempting") {
        this.#completeFailedWrite(write.id, context.traceId, error);
      }
      throw error;
    }
  }

  async sendDraft(
    input: z.infer<typeof sendDraftArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const connection = this.#select("gmail.send_draft", input.account, context);
    const draft = this.#db
      .prepare<{ connection_id: string; provider_draft_id: string }, DraftRow>(`
        SELECT provider_draft_id, rfc_message_id, status
        FROM gmail_drafts
        WHERE connection_id = @connection_id AND provider_draft_id = @provider_draft_id
      `)
      .get({ connection_id: connection.id, provider_draft_id: input.draftId });
    if (draft === undefined || draft.status !== "draft") {
      throw new GmailToolError(
        "draft_not_sendable",
        "That draft was not created by this assistant or is no longer sendable",
      );
    }
    const api = await this.#clients.forConnection(connection.id, context.traceId, context.signal);
    const write = this.#writes.prepare({
      traceId: context.traceId,
      runId: context.runId,
      toolExecutionId: context.toolExecutionId,
      connectionId: connection.id,
      connectionGeneration: connection.credentialGeneration,
      kind: "gmail_send_draft",
      request: { draftId: input.draftId, rfcMessageId: draft.rfc_message_id },
      safeSummary: { draftId: input.draftId },
    });
    const transaction = this.#db.transaction(() => {
      this.#beginWrite(write.id, context);
      const updated = this.#db
        .prepare<{ connection_id: string; provider_draft_id: string; now_ms: number }>(`
          UPDATE gmail_drafts SET status = 'send_attempting', updated_at_ms = @now_ms
          WHERE connection_id = @connection_id AND provider_draft_id = @provider_draft_id
            AND status = 'draft'
        `)
        .run({
          connection_id: connection.id,
          provider_draft_id: input.draftId,
          now_ms: Date.now(),
        });
      if (updated.changes !== 1) {
        throw new GmailToolError("draft_not_sendable", "The draft is no longer sendable");
      }
    });
    transaction.immediate();
    try {
      const response = await this.#writeRequest("drafts.send", connection, context.traceId, () =>
        api.sendDraft({
          draftId: input.draftId,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
      const sent = parseSentMessage(response.data);
      const result = {
        ok: true,
        account: { label: connection.safeLabel },
        draftId: input.draftId,
        ...sent,
      };
      const completed = this.#db.transaction(() => {
        this.#writes.completeInTransaction({
          writeId: write.id,
          traceId: context.traceId,
          state: "succeeded",
          normalizedResult: result,
          providerReference: sent,
        });
        const updated = this.#db
          .prepare<{
            connection_id: string;
            provider_draft_id: string;
            sent_message_id: string;
            provider_thread_id: string | null;
            now_ms: number;
          }>(`
            UPDATE gmail_drafts
            SET status = 'sent', sent_message_id = @sent_message_id,
                provider_thread_id = COALESCE(@provider_thread_id, provider_thread_id),
                updated_at_ms = @now_ms
            WHERE connection_id = @connection_id AND provider_draft_id = @provider_draft_id
              AND status = 'send_attempting'
          `)
          .run({
            connection_id: connection.id,
            provider_draft_id: input.draftId,
            sent_message_id: sent.messageId,
            provider_thread_id: sent.threadId,
            now_ms: Date.now(),
          });
        if (updated.changes !== 1) {
          throw new Error("The sent Gmail draft lost its durable local state");
        }
      });
      completed.immediate();
      this.#markHealthy(connection, context.traceId);
      return result;
    } catch (error) {
      if (this.#writes.get(write.id)?.state === "attempting") {
        const state = failedWriteState(error);
        const failed = this.#db.transaction(() => {
          this.#completeFailedWriteInTransaction(write.id, context.traceId, state);
          this.#db
            .prepare<{
              connection_id: string;
              provider_draft_id: string;
              status: "draft" | "ambiguous";
              now_ms: number;
            }>(`
              UPDATE gmail_drafts SET status = @status, updated_at_ms = @now_ms
              WHERE connection_id = @connection_id AND provider_draft_id = @provider_draft_id
                AND status = 'send_attempting'
            `)
            .run({
              connection_id: connection.id,
              provider_draft_id: input.draftId,
              status: state === "confirmed_failed" ? "draft" : "ambiguous",
              now_ms: Date.now(),
            });
        });
        failed.immediate();
      }
      throw error;
    }
  }

  #select(
    capability: ToolCapability,
    account: string | undefined,
    context: ToolExecutionContext,
  ): ConnectionRecord {
    const connection = this.#router.select({
      capability,
      ...(context.connectionId === null
        ? account === undefined
          ? {}
          : { account }
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

  async #writeRequest(
    operation: string,
    connection: ConnectionRecord,
    traceId: TraceId,
    request: () => Promise<GmailProviderResponse>,
  ): Promise<GmailProviderResponse> {
    this.#traceRequest(traceId, operation, connection, "attempted", { attempt: 1 });
    try {
      const response = await request();
      this.#traceRequest(traceId, operation, connection, "succeeded", {
        attempt: 1,
        providerRequestId: providerRequestId(response.headers),
      });
      return response;
    } catch (error) {
      this.#traceRequest(traceId, operation, connection, "failed", {
        attempt: 1,
        status: providerStatus(error),
        retryable: false,
      });
      throw error;
    }
  }

  #completeFailedWrite(writeId: WriteIntentId, traceId: TraceId, error: unknown): void {
    const transaction = this.#db.transaction(() => {
      this.#completeFailedWriteInTransaction(writeId, traceId, failedWriteState(error));
    });
    transaction.immediate();
  }

  #completeFailedWriteInTransaction(
    writeId: WriteIntentId,
    traceId: TraceId,
    state: "ambiguous" | "confirmed_failed",
  ): void {
    this.#writes.completeInTransaction({
      writeId,
      traceId,
      state,
      normalizedResult: failedWriteResult(state),
    });
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

type GmailToolErrorCode = "draft_not_sendable" | "rate_limited" | "provider_read_failed";

export class GmailToolError extends ModelSafeError<GmailToolErrorCode> {
  constructor(code: GmailToolErrorCode, message: string, options?: ErrorOptions) {
    super("GmailToolError", code, message, options);
  }
}

async function composeMessage(
  input: z.infer<typeof createDraftArgumentsSchema>,
  connection: ConnectionRecord,
  messageId: string,
): Promise<Buffer> {
  const from = connection.safeMetadata.email;
  const composer = new MailComposer({
    ...(typeof from === "string" ? { from } : {}),
    to: input.to,
    ...(input.cc === undefined ? {} : { cc: input.cc }),
    ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
    subject: input.subject,
    text: input.bodyText,
    ...(input.bodyHtml === undefined ? {} : { html: input.bodyHtml }),
    messageId,
    ...(input.replyToMessageId === undefined
      ? {}
      : {
          inReplyTo: input.replyToMessageId,
          references: [input.replyToMessageId],
        }),
  });
  return composer.compile().build();
}

function failedWriteState(error: unknown): "ambiguous" | "confirmed_failed" {
  const status = providerStatus(error);
  return status !== null && [400, 401, 403, 404].includes(status)
    ? "confirmed_failed"
    : "ambiguous";
}

function failedWriteResult(state: "ambiguous" | "confirmed_failed"): {
  ok: false;
  error: { code: string; message: string };
} {
  return {
    ok: false,
    error: {
      code: state === "ambiguous" ? "acceptance_unknown" : "provider_rejected",
      message:
        state === "ambiguous"
          ? "Gmail may have accepted the write; it was not repeated"
          : "Gmail rejected the write",
    },
  };
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
