import type Database from "better-sqlite3";
import type { RuntimeConfig } from "../config.js";
import type { EgressId, TraceId } from "../core/ids.js";
import type { QueueStore } from "../queue/store.js";
import type { TraceStore } from "../tracing/store.js";
import { MessageEgressService, type EgressSendPolicy } from "./egress.js";

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

  plan(input: {
    traceId: TraceId;
    failureCode: string;
    runId?: string;
    replyToGuid?: string;
    sendPolicy?: EgressSendPolicy;
  }): EgressId {
    const existing = this.#findExisting(input.traceId);
    if (existing !== undefined) {
      return existing;
    }
    const transaction = this.#db.transaction(() => {
      const concurrent = this.#findExisting(input.traceId);
      if (concurrent !== undefined) {
        return concurrent;
      }
      const egressId = this.#egress.prepare({
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
    });
    return transaction.immediate();
  }

  #findExisting(traceId: TraceId): EgressId | undefined {
    return this.#db
      .prepare<{ trace_id: string }, { id: EgressId }>(`
        SELECT id FROM egress_messages
        WHERE trace_id = @trace_id AND purpose IN ('reply', 'failure')
        ORDER BY created_at_ms
        LIMIT 1
      `)
      .get({ trace_id: traceId })?.id;
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
