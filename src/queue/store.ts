import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { newJobId, type JobId, type TraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";

export type JobType =
  | "inbound"
  | "egress_send"
  | "egress_reconcile"
  | "daily_brief"
  | "memory_maintenance";
const maximumEgressReconcileAttempts = 16;
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "blocked";

export interface ClaimedJob {
  id: JobId;
  chatId: string;
  type: JobType;
  subjectId: string;
  payload: unknown;
  attempts: number;
  leaseToken: string;
  leaseExpiresAtMs: number;
  traceId: TraceId;
  runId: string | null;
  inboundSequence: number | null;
}

interface JobRow {
  id: JobId;
  chat_id: string;
  type: JobType;
  subject_id: string;
  payload_json: string;
  attempts: number;
  lease_token: string;
  lease_expires_at_ms: number;
  trace_id: TraceId;
  run_id: string | null;
  inbound_sequence: number | null;
}

export class QueueCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueCapacityError";
  }
}

export class LostLeaseError extends Error {
  constructor(jobId: JobId) {
    super(`Lease ownership was lost for job ${jobId}`);
    this.name = "LostLeaseError";
  }
}

export class QueueStore {
  readonly #db: Database.Database;
  readonly #traces: TraceStore;
  readonly #leaseMs: number;
  readonly #maxPending: number;
  readonly #maxAttempts: number;

  constructor(input: {
    db: Database.Database;
    traces: TraceStore;
    leaseMs: number;
    maxPending: number;
    maxAttempts?: number;
  }) {
    this.#db = input.db;
    this.#traces = input.traces;
    this.#leaseMs = input.leaseMs;
    this.#maxPending = input.maxPending;
    this.#maxAttempts = input.maxAttempts ?? 5;
  }

  enqueue(input: {
    chatId: string;
    type: JobType;
    subjectId: string;
    payload: unknown;
    traceId: TraceId;
    availableAtMs?: number;
    runId?: string;
    inboundSequence?: number;
    capacityExempt?: boolean;
  }): JobId {
    const transaction = this.#db.transaction(() => this.enqueueInTransaction(input));
    return transaction.immediate();
  }

  enqueueInTransaction(input: {
    chatId: string;
    type: JobType;
    subjectId: string;
    payload: unknown;
    traceId: TraceId;
    availableAtMs?: number;
    runId?: string;
    inboundSequence?: number;
    capacityExempt?: boolean;
  }): JobId {
    if (input.capacityExempt !== true) {
      const nonterminal = this.#db
        .prepare<[], { count: number }>(`
          SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'running')
        `)
        .get();
      if (nonterminal === undefined || nonterminal.count >= this.#maxPending) {
        throw new QueueCapacityError(`The durable queue limit of ${this.#maxPending} is reached`);
      }
    }

    const now = Date.now();
    const jobId = newJobId();
    const inserted = this.#db
      .prepare<{
        id: string;
        chat_id: string;
        type: JobType;
        subject_id: string;
        payload_json: string;
        available_at_ms: number;
        trace_id: string;
        run_id: string | null;
        inbound_sequence: number | null;
        now_ms: number;
      }, { id: JobId }>(`
        INSERT INTO jobs(
          id, chat_id, type, subject_id, payload_json, status, attempts,
          available_at_ms, lease_token, lease_expires_at_ms, trace_id, run_id,
          inbound_sequence, last_error, created_at_ms, updated_at_ms
        ) VALUES (
          @id, @chat_id, @type, @subject_id, @payload_json, 'pending', 0,
          @available_at_ms, NULL, NULL, @trace_id, @run_id,
          @inbound_sequence, NULL, @now_ms, @now_ms
        )
        ON CONFLICT(type, subject_id) DO NOTHING
        RETURNING id
      `)
      .get({
        id: jobId,
        chat_id: input.chatId,
        type: input.type,
        subject_id: input.subjectId,
        payload_json: JSON.stringify(input.payload),
        available_at_ms: input.availableAtMs ?? now,
        trace_id: input.traceId,
        run_id: input.runId ?? null,
        inbound_sequence: input.inboundSequence ?? null,
        now_ms: now,
      });
    if (inserted !== undefined) {
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "queue",
        event: "enqueued",
        outcome: input.type,
        jobId,
        data: { subjectId: input.subjectId, availableAtMs: input.availableAtMs ?? now },
        occurredAtMs: now,
      });
      return inserted.id;
    }

    const existing = this.#db
      .prepare<{ type: JobType; subject_id: string }, { id: JobId }>(`
        SELECT id FROM jobs WHERE type = @type AND subject_id = @subject_id
      `)
      .get({ type: input.type, subject_id: input.subjectId });
    if (existing === undefined) {
      throw new Error("Job conflict did not resolve to an existing row");
    }
    return existing.id;
  }

  claim(nowMs = Date.now()): ClaimedJob | undefined {
    this.failExpiredFinalAttempts(nowMs);
    const leaseToken = randomUUID();
    const leaseExpiresAtMs = nowMs + this.#leaseMs;
    const transaction = this.#db.transaction(() => {
      const row = this.#db
        .prepare<{
          now_ms: number;
          lease_expires_at_ms: number;
          lease_token: string;
          max_attempts: number;
          reconcile_max_attempts: number;
        }, JobRow>(`
          WITH candidate(id) AS MATERIALIZED (
            SELECT candidate.id
            FROM jobs AS candidate
            WHERE (
              candidate.attempts < CASE candidate.type
                WHEN 'egress_reconcile' THEN @reconcile_max_attempts
                ELSE @max_attempts
              END
              OR (
                candidate.type = 'inbound'
                AND EXISTS (
                  SELECT 1
                  FROM inbound_messages AS inbound
                  JOIN agent_runs AS runs ON runs.inbound_id = inbound.id
                  WHERE inbound.id = candidate.subject_id
                    AND inbound.state = 'done'
                    AND runs.phase = 'completed'
                )
              )
            )
              AND (
                (
                  candidate.status = 'running'
                  AND candidate.lease_expires_at_ms <= @now_ms
                )
                OR
                (
                  candidate.status = 'pending'
                  AND candidate.available_at_ms <= @now_ms
                  AND NOT EXISTS (
                    SELECT 1 FROM jobs AS active
                    WHERE active.chat_id = candidate.chat_id
                      AND active.status = 'running'
                  )
                  AND NOT (${awaitingDeliveryReceiptSql("candidate")})
                  AND (
                    candidate.inbound_sequence IS NULL
                    OR NOT EXISTS (
                      SELECT 1 FROM jobs AS earlier
                      WHERE earlier.chat_id = candidate.chat_id
                        AND earlier.inbound_sequence < candidate.inbound_sequence
                        AND earlier.status IN ('pending', 'running')
                        AND NOT (${awaitingDeliveryReceiptSql("earlier")})
                    )
                  )
                )
              )
            ORDER BY
              (candidate.status = 'running') DESC,
              CASE WHEN candidate.status = 'running'
                THEN candidate.lease_expires_at_ms
              END,
              CASE candidate.type
                WHEN 'egress_send' THEN 0
                WHEN 'memory_maintenance' THEN 1
                ELSE 2
              END,
              CASE WHEN candidate.status = 'pending'
                THEN candidate.available_at_ms
              END,
              candidate.inbound_sequence,
              candidate.created_at_ms
            LIMIT 1
          )
          UPDATE jobs
          SET status = 'running',
              attempts = attempts + 1,
              lease_token = @lease_token,
              lease_expires_at_ms = @lease_expires_at_ms,
              updated_at_ms = @now_ms
          WHERE id = (SELECT id FROM candidate)
          RETURNING id, chat_id, type, subject_id, payload_json, attempts,
                    lease_token, lease_expires_at_ms, trace_id, run_id, inbound_sequence
        `)
        .get({
          now_ms: nowMs,
          lease_expires_at_ms: leaseExpiresAtMs,
          lease_token: leaseToken,
          max_attempts: this.#maxAttempts,
          reconcile_max_attempts: maximumEgressReconcileAttempts,
        });
      if (row === undefined) {
        return undefined;
      }
      this.#traces.appendInTransaction({
        traceId: row.trace_id,
        component: "queue",
        event: "claimed",
        outcome: row.type,
        jobId: row.id,
        runId: row.run_id ?? undefined,
        data: { attempt: row.attempts, leaseExpiresAtMs: row.lease_expires_at_ms },
        occurredAtMs: nowMs,
      });
      return toClaimedJob(row);
    });
    return transaction.immediate();
  }

  assertLease(job: ClaimedJob, nowMs = Date.now()): void {
    const row = this.#db
      .prepare<
        { id: string; lease_token: string; now_ms: number },
        { owned: 1 }
      >(`
        SELECT 1 AS owned
        FROM jobs
        WHERE id = @id
          AND status = 'running'
          AND lease_token = @lease_token
          AND lease_expires_at_ms > @now_ms
      `)
      .get({ id: job.id, lease_token: job.leaseToken, now_ms: nowMs });
    if (row === undefined) {
      throw new LostLeaseError(job.id);
    }
  }

  heartbeat(job: ClaimedJob, nowMs = Date.now()): void {
    const result = this.#db
      .prepare<{
        id: string;
        lease_token: string;
        lease_expires_at_ms: number;
        now_ms: number;
      }>(`
        UPDATE jobs
        SET lease_expires_at_ms = @lease_expires_at_ms, updated_at_ms = @now_ms
        WHERE id = @id
          AND status = 'running'
          AND lease_token = @lease_token
          AND lease_expires_at_ms > @now_ms
      `)
      .run({
        id: job.id,
        lease_token: job.leaseToken,
        lease_expires_at_ms: nowMs + this.#leaseMs,
        now_ms: nowMs,
      });
    if (result.changes !== 1) {
      throw new LostLeaseError(job.id);
    }
    job.leaseExpiresAtMs = nowMs + this.#leaseMs;
  }

  complete(job: ClaimedJob): void {
    this.finish(job, "succeeded", undefined);
  }

  fail(job: ClaimedJob, error: string): void {
    this.finish(job, "failed", error);
  }

  block(job: ClaimedJob, error: string): void {
    this.finish(job, "blocked", error);
  }

  canRetry(job: ClaimedJob): boolean {
    return job.attempts < this.#maximumAttempts(job.type);
  }

  requeue(job: ClaimedJob, retryAtMs: number, error: string): void {
    if (!this.canRetry(job)) {
      this.finish(job, "failed", `${error}; retry attempts exhausted`);
      return;
    }
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      const result = this.#db
        .prepare<{
          id: string;
          lease_token: string;
          retry_at_ms: number;
          error: string;
          now_ms: number;
        }>(`
          UPDATE jobs
          SET status = 'pending', available_at_ms = @retry_at_ms,
              lease_token = NULL, lease_expires_at_ms = NULL,
              last_error = @error, updated_at_ms = @now_ms
          WHERE id = @id AND status = 'running' AND lease_token = @lease_token
        `)
        .run({
          id: job.id,
          lease_token: job.leaseToken,
          retry_at_ms: retryAtMs,
          error,
          now_ms: now,
        });
      if (result.changes !== 1) {
        throw new LostLeaseError(job.id);
      }
      this.#traces.appendInTransaction({
        traceId: job.traceId,
        component: "queue",
        event: "requeued",
        outcome: job.type,
        jobId: job.id,
        runId: job.runId ?? undefined,
        data: { retryAtMs, error },
        occurredAtMs: now,
      });
    });
    transaction.immediate();
  }

  releaseForShutdown(job: ClaimedJob): boolean {
    const ambiguous = this.#db
      .prepare<{ run_id: string }, { count: number }>(`
        SELECT COUNT(*) AS count
        FROM write_intents
        WHERE run_id = @run_id AND state IN ('attempting', 'ambiguous', 'unresolved')
      `)
      .get({ run_id: job.runId ?? "" });
    if ((ambiguous?.count ?? 0) > 0) {
      return false;
    }
    const result = this.#db
      .prepare<{ id: string; lease_token: string; now_ms: number }>(`
        UPDATE jobs
        SET status = 'pending', available_at_ms = @now_ms,
            lease_token = NULL, lease_expires_at_ms = NULL, updated_at_ms = @now_ms
        WHERE id = @id AND status = 'running' AND lease_token = @lease_token
      `)
      .run({ id: job.id, lease_token: job.leaseToken, now_ms: Date.now() });
    return result.changes === 1;
  }

  private finish(job: ClaimedJob, status: "succeeded" | "failed" | "blocked", error: string | undefined): void {
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      const result = this.#db
        .prepare<{
          id: string;
          lease_token: string;
          status: "succeeded" | "failed" | "blocked";
          error: string | null;
          now_ms: number;
        }>(`
          UPDATE jobs
          SET status = @status, lease_token = NULL, lease_expires_at_ms = NULL,
              last_error = @error, updated_at_ms = @now_ms
          WHERE id = @id AND status = 'running' AND lease_token = @lease_token
        `)
        .run({
          id: job.id,
          lease_token: job.leaseToken,
          status,
          error: error ?? null,
          now_ms: now,
        });
      if (result.changes !== 1) {
        throw new LostLeaseError(job.id);
      }
      this.#traces.appendInTransaction({
        traceId: job.traceId,
        component: "queue",
        event: status,
        outcome: job.type,
        jobId: job.id,
        runId: job.runId ?? undefined,
        data: error === undefined ? {} : { error },
        occurredAtMs: now,
      });
    });
    transaction.immediate();
  }

  private failExpiredFinalAttempts(nowMs: number): void {
    const rows = this.#db
      .prepare<
        {
          now_ms: number;
          max_attempts: number;
          reconcile_max_attempts: number;
        },
        { id: JobId; trace_id: TraceId; run_id: string | null; type: JobType }
      >(`
        UPDATE jobs
        SET status = 'failed', lease_token = NULL, lease_expires_at_ms = NULL,
            last_error = COALESCE(last_error, 'lease expired after final attempt'),
            updated_at_ms = @now_ms
        WHERE status = 'running'
          AND lease_expires_at_ms <= @now_ms
          AND attempts >= CASE type
            WHEN 'egress_reconcile' THEN @reconcile_max_attempts
            ELSE @max_attempts
          END
          AND NOT (
            jobs.type = 'inbound'
            AND EXISTS (
              SELECT 1
              FROM inbound_messages AS inbound
              JOIN agent_runs AS runs ON runs.inbound_id = inbound.id
              WHERE inbound.id = jobs.subject_id
                AND inbound.state = 'done'
                AND runs.phase = 'completed'
            )
          )
        RETURNING id, trace_id, run_id, type
      `)
      .all({
        now_ms: nowMs,
        max_attempts: this.#maxAttempts,
        reconcile_max_attempts: maximumEgressReconcileAttempts,
      });
    for (const row of rows) {
      this.#traces.append({
        traceId: row.trace_id,
        component: "queue",
        event: "failed",
        outcome: "attempts_exhausted",
        jobId: row.id,
        runId: row.run_id ?? undefined,
        data: { type: row.type },
        occurredAtMs: nowMs,
      });
    }
  }
  #maximumAttempts(type: JobType): number {
    return type === "egress_reconcile" ? maximumEgressReconcileAttempts : this.#maxAttempts;
  }

}

function toClaimedJob(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    chatId: row.chat_id,
    type: row.type,
    subjectId: row.subject_id,
    payload: JSON.parse(row.payload_json) as unknown,
    attempts: row.attempts,
    leaseToken: row.lease_token,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    traceId: row.trace_id,
    runId: row.run_id,
    inboundSequence: row.inbound_sequence,
  };
}

// Wait for this or an earlier inbound reply's receipt before learning preferences.
// Waiting memory work must not hold up new inbound messages or delivery jobs.
function awaitingDeliveryReceiptSql(job: "candidate" | "earlier"): string {
  return `
    ${job}.type = 'memory_maintenance'
    AND EXISTS (
      SELECT 1
      FROM egress_messages AS reply
      JOIN jobs AS delivery
        ON delivery.subject_id = reply.id
       AND delivery.type IN ('egress_send', 'egress_reconcile')
      JOIN agent_runs AS reply_run ON reply_run.id = reply.run_id
      LEFT JOIN inbound_messages AS reply_input ON reply_input.id = reply_run.inbound_id
      WHERE reply.recipient_handle = ${job}.chat_id
        AND (
          reply.run_id = ${job}.subject_id
          OR reply_input.sequence < ${job}.inbound_sequence
        )
        AND reply.purpose = 'reply'
        AND reply.state IN ('prepared', 'attempting', 'accepted', 'sent')
        AND delivery.status IN ('pending', 'running')
    )
  `;
}
