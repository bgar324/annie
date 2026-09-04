import type Database from "better-sqlite3";
import type { RuntimeConfig } from "../config.js";
import type { EgressId, TraceId } from "../core/ids.js";
import type { QueueStore } from "../queue/store.js";
import type { TraceStore } from "../tracing/store.js";
import { MessageEgressService, type EgressSendPolicy } from "./egress.js";

interface FailurePlanInput {
  traceId: TraceId;
  failureCode: string;
  runId?: string;
  replyToGuid?: string;
  sendPolicy?: EgressSendPolicy;
}

export class FailureNotificationService {
  readonly #db: Database.Database;
  readonly #egress: MessageEgressService;
  readonly #queue: QueueStore;
  readonly #traces: TraceStore;
  readonly #recipient: string;

  constructor(input: {
    db: Database.Database;
    config: RuntimeConfig;
    egress: MessageEgressService;
    queue: QueueStore;
    traces: TraceStore;
  }) {
    this.#db = input.db;
    this.#egress = input.egress;
    this.#queue = input.queue;
    this.#traces = input.traces;
    this.#recipient = input.config.userPhoneNumber;
  }

  plan(input: FailurePlanInput): EgressId {
    const transaction = this.#db.transaction(() => this.planInTransaction(input));
    return transaction.immediate();
  }

  planInTransaction(input: FailurePlanInput): EgressId {
    const existing = this.#findExisting(input.traceId);
    return existing ?? this.#prepareInTransaction(input);
  }

  replaceSuppressedReplyInTransaction(
    input: FailurePlanInput,
    suppressedReplyId: EgressId,
  ): EgressId {
    const suppressed = this.#db
      .prepare<
        { id: string; trace_id: string; reason: string },
        { suppressed: 1 }
      >(`
        SELECT 1 AS suppressed
        FROM egress_messages
        WHERE id = @id
          AND trace_id = @trace_id
          AND purpose = 'reply'
          AND state = 'provider_failed'
          AND last_error = @reason
      `)
      .get({
        id: suppressedReplyId,
        trace_id: input.traceId,
        reason: input.failureCode,
      });
    if (suppressed === undefined) {
      throw new Error(`Reply ${suppressedReplyId} was not safely suppressed`);
    }
    const existing = this.#findExisting(input.traceId, suppressedReplyId);
    return existing ?? this.#prepareInTransaction(input);
  }

  #prepareInTransaction(input: FailurePlanInput): EgressId {
    const egressId = this.#egress.prepareInTransaction({
      traceId: input.traceId,
      recipient: this.#recipient,
      purpose: "failure",
      text: failureNotificationText(input.failureCode, input.traceId),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.replyToGuid === undefined ? {} : { replyToGuid: input.replyToGuid }),
    });
    this.#queue.enqueueInTransaction({
      chatId: this.#recipient,
      type: "egress_send",
      subjectId: egressId,
      payload: {
        egressId,
        ...(input.sendPolicy === undefined ? {} : { sendPolicy: input.sendPolicy }),
      },
      traceId: input.traceId,
      capacityExempt: true,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    });
    this.#traces.appendInTransaction({
      traceId: input.traceId,
      component: "failure_notification",
      event: "planned",
      outcome: "failure",
      runId: input.runId,
      data: { egressId, failureCode: input.failureCode },
    });
    return egressId;
  }

  #findExisting(
    traceId: TraceId,
    ignoredEgressId?: EgressId,
  ): EgressId | undefined {
    return this.#db
      .prepare<
        { trace_id: string; ignored_id: string | null },
        { id: EgressId }
      >(`
        SELECT id FROM egress_messages
        WHERE trace_id = @trace_id
          AND purpose IN ('reply', 'failure')
          AND (@ignored_id IS NULL OR id <> @ignored_id)
        ORDER BY created_at_ms
        LIMIT 1
      `)
      .get({
        trace_id: traceId,
        ignored_id: ignoredEgressId ?? null,
      })?.id;
  }
}

function failureNotificationText(failureCode: string, traceId: TraceId): string {
  if (failureCode === "missing_text") {
    return "I can only process text messages right now. Please type your request.";
  }
  if (failureCode === "unverified_write_claim") {
    return `I didn't confirm that provider change, so I didn't report it as done. Trace: ${traceId}`;
  }
  if (failureCode === "ambiguous_write") {
    return `The provider may have accepted that change, so I stopped without retrying it. Trace: ${traceId}`;
  }
  return `I couldn't complete that request. Trace: ${traceId}`;
}
