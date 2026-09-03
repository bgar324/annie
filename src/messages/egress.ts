import type Database from "better-sqlite3";
import { newEgressId, type EgressId, type TraceId, type WriteIntentId } from "../core/ids.js";
import type { ClaimedJob, QueueStore } from "../queue/store.js";
import type { TraceStore } from "../tracing/store.js";
import type { WriteStore } from "../writes/store.js";
import {
  maximumMessageTextCharacters,
  MessagingProviderError,
  type DeliveryResource,
  type MessageSender,
} from "./types.js";

export type EgressPurpose = "reply" | "recovery" | "oauth_result" | "failure";
export type EgressSendResult =
  | { kind: "accepted"; egressId: EgressId; messageHandle: string }
  | { kind: "provider_failed"; egressId: EgressId; error: string }
  | { kind: "acceptance_unknown"; egressId: EgressId; error: string }
  | {
      kind: "canceled";
      egressId: EgressId;
      reason: "daily_brief_disabled" | "daily_brief_expired";
    };

export interface EgressSendPolicy {
  kind: "daily_brief";
  expiresAtMs: number;
}

export interface EgressSendConstraint {
  policy: EgressSendPolicy;
  enabled: boolean;
}

interface EgressRow {
  id: EgressId;
  run_id: string | null;
  trace_id: TraceId;
  recipient_handle: string;
  line_handle: string;
  reply_to_guid: string | null;
  body: string;
  purpose: EgressPurpose;
  state:
    | "prepared"
    | "attempting"
    | "accepted"
    | "sent"
    | "delivered"
    | "provider_failed"
    | "acceptance_unknown"
    | "delivery_unknown";
  provider_handle: string | null;
  poll_count: number;
  poll_deadline_at_ms: number | null;
  write_id: WriteIntentId;
}

export class MessageEgressService {
  readonly #db: Database.Database;
  readonly #gateway: MessageSender;
  readonly #queue: QueueStore;
  readonly #traces: TraceStore;
  readonly #writes: WriteStore;
  readonly #lineNumber: string;

  constructor(input: {
    db: Database.Database;
    gateway: MessageSender;
    queue: QueueStore;
    traces: TraceStore;
    writes: WriteStore;
    lineNumber: string;
  }) {
    this.#db = input.db;
    this.#gateway = input.gateway;
    this.#queue = input.queue;
    this.#traces = input.traces;
    this.#writes = input.writes;
    this.#lineNumber = input.lineNumber;
  }

  planReply(input: {
    traceId: TraceId;
    recipient: string;
    text: string;
    runId?: string;
    replyToGuid?: string;
    inboundSequence?: number;
    sendPolicy?: EgressSendPolicy;
  }): EgressId {
    const transaction = this.#db.transaction(() => {
      const existing = this.#db
        .prepare<{ trace_id: string }, { id: EgressId }>(`
          SELECT id FROM egress_messages
          WHERE trace_id = @trace_id AND purpose IN ('reply', 'failure')
          ORDER BY created_at_ms
          LIMIT 1
        `)
        .get({ trace_id: input.traceId });
      const egressId =
        existing?.id ??
        this.prepare({
          traceId: input.traceId,
          recipient: input.recipient,
          text: input.text,
          purpose: "reply",
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.replyToGuid === undefined ? {} : { replyToGuid: input.replyToGuid }),
        });
      this.#queue.enqueueInTransaction({
        chatId: input.recipient,
        subjectId: egressId,
        type: "egress_send",
        payload: {
          egressId,
          ...(input.sendPolicy === undefined ? {} : { sendPolicy: input.sendPolicy }),
        },
        traceId: input.traceId,
        capacityExempt: true,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.inboundSequence === undefined
          ? {}
          : { inboundSequence: input.inboundSequence }),
      });
      if (input.runId !== undefined) {
        this.#queue.enqueueInTransaction({
          chatId: input.recipient,
          subjectId: input.runId,
          type: "memory_maintenance",
          payload: { runId: input.runId },
          traceId: input.traceId,
          runId: input.runId,
          capacityExempt: true,
          ...(input.inboundSequence === undefined
            ? {}
            : { inboundSequence: input.inboundSequence }),
        });
      }
      return egressId;
    });
    return transaction.immediate();
  }

  prepare(input: {
    traceId: TraceId;
    recipient: string;
    text: string;
    purpose: EgressPurpose;
    runId?: string;
    replyToGuid?: string;
  }): EgressId {
    const text = input.text.trim();
    if (text.length === 0 || text.length > maximumMessageTextCharacters) {
      throw new Error(
        `An iMessage reply must contain between 1 and ${maximumMessageTextCharacters} characters`,
      );
    }
    const egressId = newEgressId();
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      this.#db
        .prepare<{
          id: string;
          run_id: string | null;
          trace_id: string;
          recipient_handle: string;
          line_handle: string;
          reply_to_guid: string | null;
          body: string;
          purpose: EgressPurpose;
          now_ms: number;
        }>(`
          INSERT INTO egress_messages(
            id, run_id, trace_id, recipient_handle, line_handle, reply_to_guid,
            body, purpose, state, attempt_count, outbox_id, request_id,
            provider_message_id, poll_count, poll_deadline_at_ms, last_error,
            created_at_ms, updated_at_ms
          ) VALUES (
            @id, @run_id, @trace_id, @recipient_handle, @line_handle, @reply_to_guid,
            @body, @purpose, 'prepared', 0, NULL, NULL,
            NULL, 0, NULL, NULL, @now_ms, @now_ms
          )
        `)
        .run({
          id: egressId,
          run_id: input.runId ?? null,
          trace_id: input.traceId,
          recipient_handle: input.recipient,
          line_handle: this.#lineNumber,
          reply_to_guid: input.replyToGuid ?? null,
          body: text,
          purpose: input.purpose,
          now_ms: now,
        });
      this.#writes.prepareInTransaction({
        traceId: input.traceId,
        kind: "sendblue_send_message",
        egressId,
        request: {
          to: input.recipient,
          text,
          ...(input.replyToGuid === undefined ? {} : { replyTo: input.replyToGuid }),
        },
        safeSummary: {
          egressId,
          purpose: input.purpose,
          textBytes: Buffer.byteLength(text),
        },
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      });
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "egress",
        event: "prepared",
        outcome: input.purpose,
        runId: input.runId,
        data: { egressId, textBytes: Buffer.byteLength(text) },
        occurredAtMs: now,
      });
    });
    transaction.immediate();
    return egressId;
  }

  async sendPrepared(
    egressId: EgressId,
    job?: ClaimedJob,
    constraint?: EgressSendConstraint,
  ): Promise<EgressSendResult> {
    const preparation = this.#prepareSend(egressId, job, constraint);
    if (preparation.kind === "canceled") {
      return { kind: "canceled", egressId, reason: preparation.reason };
    }
    const egress = preparation.egress;
    try {
      const accepted = await this.#gateway.send({
        to: egress.recipient_handle,
        text: egress.body,
        ...(egress.reply_to_guid === null ? {} : { replyTo: egress.reply_to_guid }),
      });
      if (accepted.status === "failed") {
        throw new MessagingProviderError({
          message: accepted.error ?? "Sendblue confirmed that the message failed",
          kind: "terminal",
          ...(accepted.requestId === undefined ? {} : { requestId: accepted.requestId }),
        });
      }
      const now = Date.now();
      const state =
        accepted.status === "delivered"
          ? "delivered"
          : accepted.status === "sent"
            ? "sent"
            : "accepted";
      const transaction = this.#db.transaction(() => {
        this.#db
          .prepare<{
            id: string;
            state: "accepted" | "sent" | "delivered";
            provider_handle: string;
            request_id: string | null;
            provider_message_id: string | null;
            poll_deadline_at_ms: number;
            now_ms: number;
          }>(`
            UPDATE egress_messages
            SET state = @state, outbox_id = @provider_handle, request_id = @request_id,
                provider_message_id = @provider_message_id,
                poll_deadline_at_ms = @poll_deadline_at_ms, updated_at_ms = @now_ms
            WHERE id = @id AND state = 'attempting'
          `)
          .run({
            id: egressId,
            state,
            provider_handle: accepted.messageHandle,
            request_id: accepted.requestId ?? null,
            provider_message_id: state === "delivered" ? accepted.messageHandle : null,
            poll_deadline_at_ms: now + 30 * 60_000,
            now_ms: now,
          });
        this.#writes.completeInTransaction({
          writeId: egress.write_id,
          traceId: egress.trace_id,
          state: "succeeded",
          normalizedResult: {
            accepted: true,
            messageHandle: accepted.messageHandle,
            status: accepted.status,
          },
          providerReference: {
            messageHandle: accepted.messageHandle,
            requestId: accepted.requestId ?? null,
          },
        });
        if (state !== "delivered") {
          this.#queue.enqueueInTransaction({
            chatId: egress.recipient_handle,
            type: "egress_reconcile",
            subjectId: egressId,
            payload: { egressId },
            traceId: egress.trace_id,
            availableAtMs: now + 1_000,
            capacityExempt: true,
            ...(egress.run_id === null ? {} : { runId: egress.run_id }),
          });
        }
        this.#markRecoveryAttemptedInTransaction(egressId, now);
        this.#traces.appendInTransaction({
          traceId: egress.trace_id,
          component: "egress",
          event: state === "delivered" ? "delivered" : "accepted",
          outcome: accepted.status,
          providerRequestId: accepted.requestId,
          runId: egress.run_id ?? undefined,
          writeIntentId: egress.write_id,
          data: { egressId, messageHandle: accepted.messageHandle },
          occurredAtMs: now,
        });
        if (state === "delivered") {
          this.#traces.markTerminal(egress.trace_id);
        }
      });
      transaction.immediate();
      return { kind: "accepted", egressId, messageHandle: accepted.messageHandle };
    } catch (error) {
      const failure =
        error instanceof MessagingProviderError
          ? error
          : new MessagingProviderError({
              message: error instanceof Error ? error.message : "Unknown Sendblue failure",
              kind: "ambiguous",
              cause: error,
            });
      const state = failure.kind === "terminal" ? "provider_failed" : "acceptance_unknown";
      const writeState = failure.kind === "terminal" ? "confirmed_failed" : "ambiguous";
      const now = Date.now();
      const transaction = this.#db.transaction(() => {
        this.#db
          .prepare<{
            id: string;
            state: "provider_failed" | "acceptance_unknown";
            error: string;
            now_ms: number;
          }>(`
            UPDATE egress_messages
            SET state = @state, last_error = @error, updated_at_ms = @now_ms
            WHERE id = @id AND state = 'attempting'
          `)
          .run({ id: egressId, state, error: failure.message, now_ms: now });
        this.#writes.completeInTransaction({
          writeId: egress.write_id,
          traceId: egress.trace_id,
          state: writeState,
          normalizedResult: {
            sent: false,
            classification: failure.kind,
            message: failure.message,
          },
          providerReference: {
            status: failure.status ?? null,
            requestId: failure.requestId ?? null,
          },
        });
        this.#markRecoveryAttemptedInTransaction(egressId, now);
        this.#traces.appendInTransaction({
          traceId: egress.trace_id,
          component: "egress",
          event: state,
          outcome: failure.kind,
          providerRequestId: failure.requestId,
          runId: egress.run_id ?? undefined,
          writeIntentId: egress.write_id,
          data: { egressId, status: failure.status, error: failure.message },
          occurredAtMs: now,
        });
        this.#traces.markTerminal(egress.trace_id);
      });
      transaction.immediate();
      return failure.kind === "terminal"
        ? { kind: "provider_failed", egressId, error: failure.message }
        : { kind: "acceptance_unknown", egressId, error: failure.message };
    }
  }

  #prepareSend(
    egressId: EgressId,
    job: ClaimedJob | undefined,
    constraint: EgressSendConstraint | undefined,
  ):
    | { kind: "attempting"; egress: EgressRow }
    | {
        kind: "canceled";
        reason: "daily_brief_disabled" | "daily_brief_expired";
      } {
    const transaction = this.#db.transaction(() => {
      const egress = this.#get(egressId);
      if (egress.state !== "prepared") {
        throw new Error(`Egress ${egressId} is not prepared`);
      }
      const nowMs = Date.now();
      if (
        constraint !== undefined &&
        (!constraint.enabled || nowMs >= constraint.policy.expiresAtMs)
      ) {
        if (job === undefined) {
          throw new Error("A constrained egress send requires a durable job lease");
        }
        const reason: "daily_brief_disabled" | "daily_brief_expired" =
          constraint.enabled ? "daily_brief_expired" : "daily_brief_disabled";
        this.#cancelPreparedInTransaction(egress, job, nowMs, reason);
        return { kind: "canceled" as const, reason };
      }
      this.#writes.beginAttempt({
        writeId: egress.write_id,
        traceId: egress.trace_id,
        ...(job === undefined
          ? {}
          : {
              jobLease: {
                jobId: job.id,
                leaseToken: job.leaseToken,
                nowMs,
              },
            }),
      });
      return { kind: "attempting" as const, egress };
    });
    return transaction.immediate();
  }

  #cancelPreparedInTransaction(
    egress: EgressRow,
    job: ClaimedJob,
    nowMs: number,
    reason: "daily_brief_disabled" | "daily_brief_expired",
  ): void {
    const result = {
      ok: false,
      error: {
        code: reason,
        message: "The daily brief was canceled before provider dispatch",
      },
    };
    this.#writes.cancelPreparedInTransaction({
      writeId: egress.write_id,
      traceId: egress.trace_id,
      normalizedResult: result,
      jobLease: {
        jobId: job.id,
        leaseToken: job.leaseToken,
        nowMs,
      },
    });
    const updated = this.#db
      .prepare<{ id: string; reason: string; now_ms: number }>(`
        UPDATE egress_messages
        SET state = 'provider_failed', last_error = @reason, updated_at_ms = @now_ms
        WHERE id = @id AND state = 'prepared' AND attempt_count = 0
      `)
      .run({ id: egress.id, reason, now_ms: nowMs });
    if (updated.changes !== 1) {
      throw new Error(`Egress ${egress.id} is not cancelable`);
    }
    this.#traces.appendInTransaction({
      traceId: egress.trace_id,
      component: "egress",
      event: "canceled",
      outcome: reason,
      jobId: job.id,
      runId: egress.run_id ?? undefined,
      data: { egressId: egress.id },
      occurredAtMs: nowMs,
    });
    this.#traces.markTerminal(egress.trace_id);
  }

  async reconcile(egressId: EgressId): Promise<
    | { kind: "delivered" | "failed" | "delivery_unknown" }
    | { kind: "pending"; retryAtMs: number }
  > {
    const egress = this.#get(egressId);
    if (egress.state === "delivered") {
      return { kind: "delivered" };
    }
    if (egress.state === "provider_failed") {
      return { kind: "failed" };
    }
    if (
      egress.state === "delivery_unknown" ||
      egress.state === "acceptance_unknown" ||
      egress.provider_handle === null
    ) {
      return { kind: "delivery_unknown" };
    }

    const delivery = await this.#getDeliveryStatus(egress);
    const now = Date.now();
    if (delivery.status === "failed") {
      this.#updateDeliveryState(egress, "provider_failed", now, {
        requestId: delivery.requestId,
        error: delivery.error,
      });
      return { kind: "failed" };
    }
    if (delivery.status === "delivered") {
      const transaction = this.#db.transaction(() => {
        this.#db
          .prepare<{
            id: string;
            provider_message_id: string;
            request_id: string | null;
            now_ms: number;
          }>(`
            UPDATE egress_messages
            SET state = 'delivered', provider_message_id = @provider_message_id,
                request_id = @request_id, updated_at_ms = @now_ms
            WHERE id = @id AND state IN ('accepted', 'sent', 'delivery_unknown')
          `)
          .run({
            id: egress.id,
            provider_message_id: delivery.messageHandle,
            request_id: delivery.requestId ?? null,
            now_ms: now,
          });
        this.#traces.appendInTransaction({
          traceId: egress.trace_id,
          component: "egress",
          event: "delivered",
          outcome: "status",
          providerRequestId: delivery.requestId,
          runId: egress.run_id ?? undefined,
          data: { egressId: egress.id, messageHandle: delivery.messageHandle },
          occurredAtMs: now,
        });
        this.#traces.markTerminal(egress.trace_id);
      });
      transaction.immediate();
      return { kind: "delivered" };
    }

    if (egress.poll_count >= 11 || (egress.poll_deadline_at_ms ?? 0) <= now) {
      this.#updateDeliveryState(egress, "delivery_unknown", now, {
        requestId: delivery.requestId,
        status: delivery.status,
      });
      return { kind: "delivery_unknown" };
    }
    this.#incrementPoll(egress, now, delivery);
    return {
      kind: "pending",
      retryAtMs:
        now +
        (delivery.status === "sent"
          ? 10_000
          : Math.min(60_000, 1_000 * 2 ** egress.poll_count)),
    };
  }

  markReconciliationUnknown(egressId: EgressId, error: string): void {
    const egress = this.#get(egressId);
    if (
      egress.state === "delivered" ||
      egress.state === "provider_failed" ||
      egress.state === "delivery_unknown"
    ) {
      return;
    }
    if (egress.state !== "accepted" && egress.state !== "sent") {
      throw new Error(`Egress ${egressId} cannot end reconciliation from ${egress.state}`);
    }
    this.#updateDeliveryState(egress, "delivery_unknown", Date.now(), { error });
  }

  #get(egressId: EgressId): EgressRow {
    const row = this.#db
      .prepare<{ id: string }, EgressRow>(`
        SELECT egress.id, egress.run_id, egress.trace_id, egress.recipient_handle,
               egress.line_handle, egress.reply_to_guid, egress.body, egress.purpose,
               egress.state, egress.outbox_id AS provider_handle, egress.poll_count,
               egress.poll_deadline_at_ms, writes.id AS write_id
        FROM egress_messages AS egress
        JOIN write_intents AS writes ON writes.egress_id = egress.id
        WHERE egress.id = @id
      `)
      .get({ id: egressId });
    if (row === undefined) {
      throw new Error(`Unknown egress: ${egressId}`);
    }
    return row;
  }

  async #getDeliveryStatus(egress: EgressRow): Promise<DeliveryResource> {
    const messageHandle = egress.provider_handle;
    if (messageHandle === null) {
      throw new Error(`Egress ${egress.id} has no provider handle to reconcile`);
    }
    this.#traces.append({
      traceId: egress.trace_id,
      component: "egress",
      event: "reconciliation_status_attempted",
      outcome: "sendblue_get_status",
      runId: egress.run_id ?? undefined,
      data: {
        egressId: egress.id,
        messageHandle,
        pollNumber: egress.poll_count + 1,
      },
    });
    try {
      const delivery = await this.#gateway.getStatus(messageHandle);
      this.#traces.append({
        traceId: egress.trace_id,
        component: "egress",
        event: "reconciliation_status_completed",
        outcome: delivery.status,
        providerRequestId: delivery.requestId,
        runId: egress.run_id ?? undefined,
        data: {
          egressId: egress.id,
          messageHandle,
          pollNumber: egress.poll_count + 1,
        },
      });
      return delivery;
    } catch (error) {
      this.#traces.append({
        traceId: egress.trace_id,
        component: "egress",
        event: "reconciliation_status_failed",
        outcome: error instanceof MessagingProviderError ? error.kind : "unknown",
        providerRequestId:
          error instanceof MessagingProviderError ? error.requestId : undefined,
        runId: egress.run_id ?? undefined,
        data: {
          egressId: egress.id,
          messageHandle,
          pollNumber: egress.poll_count + 1,
          status: error instanceof MessagingProviderError ? error.status : undefined,
          failureType: error instanceof Error ? error.name : "unknown",
        },
      });
      throw error;
    }
  }

  #incrementPoll(egress: EgressRow, now: number, delivery: DeliveryResource): void {
    this.#db
      .prepare<{
        id: string;
        sent: 0 | 1;
        request_id: string | null;
        now_ms: number;
      }>(`
        UPDATE egress_messages
        SET state = CASE WHEN @sent = 1 THEN 'sent' ELSE state END,
            poll_count = poll_count + 1, request_id = @request_id,
            updated_at_ms = @now_ms
        WHERE id = @id AND state IN ('accepted', 'sent')
      `)
      .run({
        id: egress.id,
        sent: delivery.status === "sent" ? 1 : 0,
        request_id: delivery.requestId ?? null,
        now_ms: now,
      });
  }

  #updateDeliveryState(
    egress: EgressRow,
    state: "provider_failed" | "delivery_unknown",
    now: number,
    data: unknown,
  ): void {
    const transaction = this.#db.transaction(() => {
      this.#db
        .prepare<{ id: string; state: string; now_ms: number }>(`
          UPDATE egress_messages
          SET state = @state, updated_at_ms = @now_ms
          WHERE id = @id AND state IN ('accepted', 'sent')
        `)
        .run({ id: egress.id, state, now_ms: now });
      this.#traces.appendInTransaction({
        traceId: egress.trace_id,
        component: "egress",
        event: state,
        outcome: "reconciliation",
        runId: egress.run_id ?? undefined,
        data: { egressId: egress.id, ...objectData(data) },
        occurredAtMs: now,
      });
      this.#traces.markTerminal(egress.trace_id);
    });
    transaction.immediate();
  }

  #markRecoveryAttemptedInTransaction(egressId: EgressId, now: number): void {
    this.#db
      .prepare<{ egress_id: string; now_ms: number }>(`
        UPDATE recovery_notices
        SET status = 'attempted', attempted_at_ms = @now_ms
        WHERE egress_id = @egress_id AND status = 'planned'
      `)
      .run({ egress_id: egressId, now_ms: now });
  }
}

function objectData(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}
