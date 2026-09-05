import Sendblue, { APIError, APIUserAbortError } from "sendblue";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import {
  MessagingProviderError,
  type DeliveryResource,
  type InboundMessage,
  type InboundPage,
  type InboundWakeStream,
  type MessageGateway,
} from "./types.js";

const isoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const statusSchema = z.enum([
  "REGISTERED",
  "PENDING",
  "SENT",
  "DELIVERED",
  "RECEIVED",
  "QUEUED",
  "ERROR",
  "DECLINED",
  "ACCEPTED",
  "SUCCESS",
]);
const inboundMessageSchema = z
  .object({
    content: z.string().max(100_000).nullish(),
    date_sent: isoTimestamp,
    date_updated: isoTimestamp,
    from_number: z.string().min(1),
    group_id: z.string().max(512).nullish(),
    is_outbound: z.boolean(),
    media_url: z.string().max(8_192).nullish(),
    message_handle: z.string().min(1).max(512),
    message_type: z.enum(["message", "group", "location"]),
    number: z.string().min(1),
    reply_to: z
      .object({ message_handle: z.string().min(1).max(512) })
      .loose()
      .optional(),
    sendblue_number: z.string().min(1),
    service: z.enum(["iMessage", "SMS", "RCS"]),
    status: statusSchema,
    to_number: z.string().min(1),
  })
  .loose();
const inboundPageSchema = z
  .object({
    data: z.array(inboundMessageSchema).max(100),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .loose(),
  })
  .loose();
// Sendblue reports the whole message lifecycle here, not only the four values its status
// endpoint documents (see its message object): REGISTERED, PENDING, ACCEPTED, and QUEUED
// precede handoff, SENT means Apple has it, DELIVERED and READ mean the device has it, ERROR
// and DECLINED mean it failed. An early poll used to fail the codec on a pre-handoff value
// and end reconciliation as delivery-unknown, dropping the delivered reply from history.
const deliveryStatusSchema = z.enum([
  "REGISTERED", "PENDING", "ACCEPTED", "QUEUED", "SENT", "DELIVERED", "READ", "ERROR", "DECLINED",
]);
const deliverySchema = z
  .object({
    error_code: z.number().nullish(),
    error_message: z.string().max(4_096).nullish(),
    message_handle: z.string().min(1).max(512),
    status: deliveryStatusSchema,
  })
  .loose();
const statusDeliverySchema = deliverySchema
  .extend({
    status: z.union([
      deliveryStatusSchema,
      z.object({ status: deliveryStatusSchema }).loose(),
    ]),
  })
  .transform((delivery) => ({
    ...delivery,
    status: typeof delivery.status === "string" ? delivery.status : delivery.status.status,
  }));
const eventSchema = z
  .object({
    id: z.string().min(1).max(512),
    occurred_at: isoTimestamp,
    type: z.string().min(1).max(128),
    version: z.literal(1),
    data: z.record(z.string(), z.unknown()),
  })
  .loose();
const maximumApiResponseBytes = 4 * 1_024 * 1_024;

export class SendblueGateway implements MessageGateway {
  readonly #client: Sendblue;
  readonly #fromNumber: string;
  readonly #userNumber: string;

  constructor(config: RuntimeConfig, fetchImpl: typeof fetch = fetch) {
    this.#client = new Sendblue({
      apiKey: config.sendblue.apiKeyId,
      apiSecret: config.sendblue.apiSecretKey,
      baseURL: config.sendblue.baseUrl,
      timeout: config.limits.providerRequestTimeoutMs,
      maxRetries: 0,
      fetch: fetchImpl,
      logLevel: "off",
    });
    this.#fromNumber = config.sendblue.fromNumber;
    this.#userNumber = config.userPhoneNumber;
  }

  async listInbound(input: {
    updatedAtGteMs: number;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }): Promise<InboundPage> {
    try {
      const response = await this.#client.messages
        .list(
          {
            from_number: this.#userNumber,
            is_outbound: "false",
            limit: input.limit,
            message_type: "message",
            offset: input.offset,
            order_by: "updatedAt",
            order_direction: "asc",
            sendblue_number: this.#fromNumber,
            service: "iMessage",
            status: "RECEIVED",
            updated_at_gte: new Date(input.updatedAtGteMs).toISOString(),
          },
          { signal: input.signal, maxRetries: 0 },
        )
        .asResponse();
      const page = parseResponse(
        inboundPageSchema,
        await boundedResponseJson(response, false),
        false,
      );
      if (
        page.pagination.offset !== input.offset ||
        page.pagination.limit !== input.limit ||
        page.pagination.total < input.offset + page.data.length
      ) {
        throw protocolError(false);
      }
      const messages = page.data.map(toInboundMessage);
      for (let index = 1; index < messages.length; index += 1) {
        if ((messages[index - 1]?.updatedAtMs ?? 0) > (messages[index]?.updatedAtMs ?? 0)) {
          throw protocolError(false);
        }
      }
      return {
        messages,
        total: page.pagination.total,
        ...requestId(response),
      };
    } catch (error) {
      throw normalizeMessagingError(error, false);
    }
  }

  async openInboundWakeStream(signal: AbortSignal): Promise<InboundWakeStream> {
    try {
      const { data: stream, response } = await this.#client.events
        .stream({ types: "message.received" }, { signal, maxRetries: 0 })
        .withResponse();
      return {
        events: validatedWakeEvents(stream, signal),
        ...requestId(response),
      };
    } catch (error) {
      throw normalizeMessagingError(error, false);
    }
  }

  async send(input: { to: string; text: string; replyTo?: string }): Promise<DeliveryResource> {
    try {
      const response = await this.#client.messages
        .send(
          {
            from_number: this.#fromNumber,
            number: input.to,
            content: input.text,
            ...(input.replyTo === undefined
              ? {}
              : { reply_to: { message_handle: input.replyTo } }),
          },
          { maxRetries: 0 },
        )
        .asResponse();
      const delivery = parseResponse(
        deliverySchema,
        await boundedResponseJson(response, true),
        true,
      );
      const normalized = toDeliveryResource(delivery, response);
      if (normalized.status === "failed") {
        throw new MessagingProviderError({
          message: "Sendblue confirmed that the message failed",
          kind: "terminal",
          ...(normalized.requestId === undefined ? {} : { requestId: normalized.requestId }),
        });
      }
      return normalized;
    } catch (error) {
      throw normalizeMessagingError(error, true);
    }
  }

  async getStatus(messageHandle: string): Promise<DeliveryResource> {
    try {
      const response = await this.#client.messages
        .getStatus({ handle: messageHandle }, { maxRetries: 0 })
        .asResponse();
      const delivery = parseResponse(
        statusDeliverySchema,
        await boundedResponseJson(response, false),
        false,
      );
      if (delivery.message_handle !== messageHandle) {
        throw protocolError(false);
      }
      return toDeliveryResource(delivery, response);
    } catch (error) {
      const normalized = normalizeMessagingError(error, false);
      // A malformed status body is retried under the bounded reconciliation budget; only a
      // provider verdict may end a delivery check, so it never becomes delivery-unknown here.
      throw normalized.kind === "terminal" && normalized.status === undefined
        ? new MessagingProviderError({ message: normalized.message, kind: "transient" })
        : normalized;
    }
  }
}

function toInboundMessage(message: z.infer<typeof inboundMessageSchema>): InboundMessage {
  return {
    id: message.message_handle,
    senderNumber: message.from_number,
    contactNumber: message.number,
    lineNumber: message.sendblue_number,
    recipientNumber: message.to_number,
    text: normalizedText(message.content),
    hasMedia: normalizedText(message.media_url) !== null,
    isOutbound: message.is_outbound,
    messageType: message.message_type,
    groupId: normalizedText(message.group_id),
    service: message.service,
    status: message.status,
    sentAtMs: Date.parse(message.date_sent),
    updatedAtMs: Date.parse(message.date_updated),
    replyToId: message.reply_to?.message_handle ?? null,
  };
}

function toDeliveryResource(
  delivery: z.infer<typeof deliverySchema>,
  response: Response,
): DeliveryResource {
  const status = deliveryStatus(delivery.status);
  return {
    messageHandle: delivery.message_handle,
    status,
    ...requestId(response),
    error: status === "failed" ? "Sendblue delivery failed" : null,
  };
}

function deliveryStatus(value: z.infer<typeof deliveryStatusSchema>): DeliveryResource["status"] {
  switch (value) {
    case "SENT":
      return "sent";
    case "DELIVERED":
    case "READ":
      return "delivered";
    case "ERROR":
    case "DECLINED":
      return "failed";
    default:
      return "pending";
  }
}

async function* validatedWakeEvents(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<void> {
  try {
    for await (const rawEvent of stream) {
      if (signal.aborted) {
        return;
      }
      const event = parseResponse(eventSchema, rawEvent, false);
      if (event.type === "message.received") {
        yield undefined;
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof APIUserAbortError) {
      return;
    }
    throw normalizeMessagingError(error, false);
  }
}

function parseResponse<T extends z.ZodType>(
  schema: T,
  value: unknown,
  write: boolean,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw protocolError(write);
  }
  return parsed.data;
}

function protocolError(write: boolean): MessagingProviderError {
  return new MessagingProviderError({
    message: "Sendblue returned an invalid response",
    kind: write ? "ambiguous" : "terminal",
  });
}

async function boundedResponseJson(response: Response, write: boolean): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumApiResponseBytes) {
    throw oversizedResponseError(response.status, write);
  }
  if (response.body === null) {
    throw protocolError(write);
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let totalBytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    totalBytes += next.value.byteLength;
    if (totalBytes > maximumApiResponseBytes) {
      await reader.cancel();
      throw oversizedResponseError(response.status, write);
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
  } catch {
    throw protocolError(write);
  }
}

function oversizedResponseError(status: number, write: boolean): MessagingProviderError {
  return new MessagingProviderError({
    message: "Sendblue response exceeded 4 MiB",
    kind: write ? "ambiguous" : "transient",
    status,
  });
}

function requestId(response: Response): { requestId?: string } {
  const value = response.headers.get("x-request-id") ?? response.headers.get("sb-request-id");
  return value === null || value.length === 0 ? {} : { requestId: value };
}

function normalizedText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length === 0 ? null : text;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(3_600_000, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(3_600_000, Math.max(0, date - Date.now()))
    : undefined;
}

function normalizeMessagingError(error: unknown, write: boolean): MessagingProviderError {
  if (error instanceof MessagingProviderError) {
    return error;
  }
  if (error instanceof APIError) {
    const status = error.status;
    const terminal =
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 409 &&
      (!write ? status !== 429 : true);
    const request =
      error.headers === undefined
        ? undefined
        : (error.headers.get("x-request-id") ?? error.headers.get("sb-request-id") ?? undefined);
    const retryAfterMs =
      error.headers === undefined
        ? undefined
        : retryAfterMilliseconds(error.headers.get("retry-after"));
    return new MessagingProviderError({
      message: status === undefined ? "Sendblue connection failed" : `Sendblue HTTP ${status}`,
      kind: terminal ? "terminal" : write ? "ambiguous" : "transient",
      ...(status === undefined ? {} : { status }),
      ...(request === undefined ? {} : { requestId: request }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      cause: error,
    });
  }
  return new MessagingProviderError({
    message: error instanceof Error ? error.message : "Unknown Sendblue failure",
    kind: write ? "ambiguous" : "transient",
    cause: error,
  });
}
