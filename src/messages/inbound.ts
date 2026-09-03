import type Database from "better-sqlite3";
import { newInboundId, newTraceId, type TraceId } from "../core/ids.js";
import type { QueueStore } from "../queue/store.js";
import type { TraceEvictionService } from "../tracing/eviction.js";
import type { TraceProjector } from "../tracing/jsonl.js";
import type { TraceStore } from "../tracing/store.js";
import type { InboundMessage } from "./types.js";

export type IngressResult =
  | { kind: "accepted"; traceId: TraceId; duplicate: false }
  | { kind: "duplicate"; traceId: TraceId; duplicate: true }
  | { kind: "rejected"; traceId: TraceId; reason: string };

interface DeliveryConflictRow {
  id: string;
  provider_delivery_id: string;
  provider_message_id: string | null;
}

export class MessageIngressService {
  readonly #db: Database.Database;
  readonly #queue: QueueStore;
  readonly #traces: TraceStore;
  readonly #projector: TraceProjector;
  readonly #eviction: TraceEvictionService;
  #lineNumber: string;
  readonly #trustedSender: string;

  constructor(input: {
    db: Database.Database;
    queue: QueueStore;
    traces: TraceStore;
    projector: TraceProjector;
    eviction: TraceEvictionService;
    lineNumber: string;
    trustedSender: string;
  }) {
    this.#db = input.db;
    this.#queue = input.queue;
    this.#traces = input.traces;
    this.#projector = input.projector;
    this.#eviction = input.eviction;
    this.#lineNumber = input.lineNumber;
    this.#trustedSender = input.trustedSender;
  }

  ingest(message: InboundMessage): IngressResult {
    const traceId = newTraceId();
    const transaction = this.#db.transaction(() => {
      const now = Date.now();
      this.#traces.appendInTransaction({
        traceId,
        component: "ingress",
        event: "observed",
        outcome: message.status,
        data: {
          providerMessageId: message.id,
          sentAtMs: message.sentAtMs,
          updatedAtMs: message.updatedAtMs,
        },
        occurredAtMs: now,
      });

      const inserted = this.#insertDelivery(message, traceId, now);
      if (!inserted) {
        this.#validateDuplicate(message.id);
        this.#traces.appendInTransaction({
          traceId,
          component: "ingress",
          event: "duplicate",
          outcome: "message.received",
          data: { providerMessageId: message.id },
          occurredAtMs: now,
        });
        this.#traces.markTerminal(traceId);
        return { kind: "duplicate", traceId, duplicate: true } satisfies IngressResult;
      }

      const rejection = this.#rejectionReason(message);
      if (rejection !== undefined) {
        this.#traces.appendInTransaction({
          traceId,
          component: "ingress",
          event: "rejected",
          outcome: rejection,
          data: {
            lineMatched:
              message.lineNumber === this.#lineNumber &&
              message.recipientNumber === this.#lineNumber,
            senderMatched:
              message.senderNumber === this.#trustedSender &&
              message.contactNumber === this.#trustedSender,
            isOutbound: message.isOutbound,
          },
          occurredAtMs: now,
        });
        this.#traces.markTerminal(traceId);
        return { kind: "rejected", traceId, reason: rejection } satisfies IngressResult;
      }

      const inboundId = newInboundId();
      const text = normalizedText(message.text);
      const sequence = this.#nextInboundSequence();
      this.#db
        .prepare<{
          id: string;
          delivery_id: string;
          provider_message_id: string;
          chat_id: string;
          guid: string;
          sender: string;
          line_id: string;
          line_handle: string;
          sequence: number;
          text: string | null;
          attachment_json: string;
          trace_id: string;
          now_ms: number;
        }>(`
          INSERT INTO inbound_messages(
            id, delivery_id, provider_message_id, chat_id, guid, sender,
            line_id, line_handle, sequence, state, text, is_audio,
            attachment_json, trace_id, created_at_ms, updated_at_ms
          ) VALUES (
            @id, @delivery_id, @provider_message_id, @chat_id, @guid, @sender,
            @line_id, @line_handle, @sequence, 'ready', @text, 0,
            @attachment_json, @trace_id, @now_ms, @now_ms
          )
        `)
        .run({
          id: inboundId,
          delivery_id: `sb_${message.id}`,
          provider_message_id: message.id,
          chat_id: message.senderNumber,
          guid: message.id,
          sender: message.senderNumber,
          line_id: message.lineNumber,
          line_handle: message.lineNumber,
          sequence,
          text,
          attachment_json: JSON.stringify({
            kind: "message",
            providerMessageId: message.id,
            sentAtMs: message.sentAtMs,
            updatedAtMs: message.updatedAtMs,
            mediaAvailable: message.hasMedia,
          }),
          trace_id: traceId,
          now_ms: now,
        });

      this.#queue.enqueueInTransaction({
        chatId: message.senderNumber,
        type: "inbound",
        subjectId: inboundId,
        payload: { inboundId },
        traceId,
        availableAtMs: now,
        inboundSequence: sequence,
      });
      this.#traces.appendInTransaction({
        traceId,
        component: "ingress",
        event: "accepted",
        outcome: "ready",
        data: {
          inboundId,
          providerMessageId: message.id,
          hasMedia: message.hasMedia,
          textBytes: text === null ? 0 : Buffer.byteLength(text),
        },
        occurredAtMs: now,
      });
      return { kind: "accepted", traceId, duplicate: false } satisfies IngressResult;
    });

    const result = transaction.immediate();
    if (result.kind === "duplicate") {
      // The overlap window re-observes the newest message on every sweep, so
      // duplicate observations are steady-state noise with nothing to debug.
      this.#eviction.evictTrace(traceId);
      return result;
    }
    try {
      this.#projector.project(traceId);
    } catch {
      // The durable spool repairs this projection on the next worker or startup pass.
    }
    return result;
  }

  #insertDelivery(message: InboundMessage, traceId: TraceId, now: number): boolean {
    const row = this.#db
      .prepare<{
        id: string;
        provider_delivery_id: string;
        provider_message_id: string;
        line_id: string;
        line_handle: string;
        normalized_json: string;
        trace_id: string;
        received_at_ms: number;
      }, { id: string }>(`
        INSERT INTO webhook_deliveries(
          id, provider_delivery_id, provider_message_id, event_kind, line_id,
          line_handle, outbox_id, normalized_json, trace_id, received_at_ms
        ) VALUES (
          @id, @provider_delivery_id, @provider_message_id, 'message.received', @line_id,
          @line_handle, NULL, @normalized_json, @trace_id, @received_at_ms
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `)
      .get({
        id: `sb_${message.id}`,
        provider_delivery_id: message.id,
        provider_message_id: message.id,
        line_id: message.lineNumber,
        line_handle: message.lineNumber,
        normalized_json: JSON.stringify({
          kind: "message.received",
          providerMessageId: message.id,
          sentAtMs: message.sentAtMs,
          updatedAtMs: message.updatedAtMs,
          textBytes: message.text === null ? 0 : Buffer.byteLength(message.text),
          mediaAvailable: message.hasMedia,
          service: message.service,
        }),
        trace_id: traceId,
        received_at_ms: now,
      });
    return row !== undefined;
  }

  #validateDuplicate(messageId: string): void {
    const rows = this.#db
      .prepare<{ message_id: string }, DeliveryConflictRow>(`
        SELECT id, provider_delivery_id, provider_message_id
        FROM webhook_deliveries
        WHERE provider_delivery_id = @message_id OR provider_message_id = @message_id
      `)
      .all({ message_id: messageId });
    if (
      rows.length !== 1 ||
      rows[0]?.provider_delivery_id !== messageId ||
      rows[0]?.provider_message_id !== messageId
    ) {
      throw new Error("Sendblue message idempotency keys resolve to different deliveries");
    }
  }

  #rejectionReason(message: InboundMessage): string | undefined {
    if (
      message.lineNumber !== this.#lineNumber ||
      message.recipientNumber !== this.#lineNumber
    ) {
      return "line_not_allowed";
    }
    if (
      message.senderNumber !== this.#trustedSender ||
      message.contactNumber !== this.#trustedSender
    ) {
      return "sender_not_allowed";
    }
    if (message.isOutbound) {
      return "message_from_assistant_line";
    }
    if (message.messageType !== "message" || message.groupId !== null) {
      return "group_not_allowed";
    }
    if (message.service !== "iMessage") {
      return "service_not_allowed";
    }
    if (message.status !== "RECEIVED") {
      return "status_not_received";
    }
    return undefined;
  }

  #nextInboundSequence(): number {
    const row = this.#db
      .prepare<[], { sequence: number }>(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM inbound_messages
      `)
      .get();
    if (row === undefined) {
      throw new Error("Unable to allocate inbound sequence");
    }
    return row.sequence;
  }
}

function normalizedText(value: string | null): string | null {
  const text = value?.trim() ?? "";
  return text.length === 0 ? null : text;
}
