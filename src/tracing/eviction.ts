import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { TraceId } from "../core/ids.js";
import { traceFileName } from "./store.js";

/**
 * Traces are debugging artifacts, not functional state. A turn that finished
 * cleanly — completed run, memory maintenance applied, reply accepted or
 * delivered, no failure notice, no open write, no queued work — has nothing
 * left to observe, so its trace is evicted immediately instead of waiting for
 * age or byte-cap retention. Failures, ambiguous writes, and in-flight turns
 * keep their traces until the retention window expires them.
 */
export class TraceEvictionService {
  readonly #db: Database.Database;
  readonly #traceDir: string;

  constructor(input: { db: Database.Database; traceDir: string }) {
    this.#db = input.db;
    this.#traceDir = input.traceDir;
  }

  evictTrace(traceId: TraceId): boolean {
    const transaction = this.#db.transaction(() => {
      const result = this.#db
        .prepare<{ trace_id: string }>("DELETE FROM trace_streams WHERE trace_id = @trace_id")
        .run({ trace_id: traceId });
      return result.changes === 1;
    });
    const existed = transaction.immediate();
    if (existed) {
      removeFile(join(this.#traceDir, traceFileName(traceId)));
    }
    return existed;
  }

  maybeEvictSuccessfulTurn(traceId: TraceId): boolean {
    const eligible = this.#db
      .prepare<{ trace_id: string }>(`${successfulTurnPredicateSql} AND stream.trace_id = @trace_id`)
      .get({ trace_id: traceId });
    if (eligible === undefined) {
      return false;
    }
    return this.evictTrace(traceId);
  }

  evictCompletedTurns(): readonly TraceId[] {
    const rows = this.#db
      .prepare<[], { trace_id: TraceId }>(`${successfulTurnPredicateSql} ORDER BY stream.trace_id`)
      .all();
    const evicted: TraceId[] = [];
    for (const row of rows) {
      if (this.evictTrace(row.trace_id)) {
        evicted.push(row.trace_id);
      }
    }
    return evicted;
  }

  /**
   * Evicts a sweep trace unless it recorded any of the given failure events.
   * Used by the receiver for poll and wake-stream traces: a clean rotation is
   * pure noise, while a failed sweep stays debuggable until retention expires
   * it.
   */
  evictUnlessEvents(traceId: TraceId, failureEvents: readonly string[]): boolean {
    if (failureEvents.length === 0) {
      return this.evictTrace(traceId);
    }
    const placeholders = failureEvents.map(() => "?").join(", ");
    const failed = this.#db
      .prepare(
        `SELECT 1 FROM trace_event_spool WHERE trace_id = ? AND event IN (${placeholders}) LIMIT 1`,
      )
      .get(traceId, ...failureEvents);
    if (failed !== undefined) {
      return false;
    }
    return this.evictTrace(traceId);
  }
}

const successfulTurnPredicateSql = `
  SELECT stream.trace_id
  FROM trace_streams AS stream
  JOIN agent_runs AS run ON run.trace_id = stream.trace_id
  WHERE run.phase = 'completed'
    AND run.memory_maintenance_status IN ('updated', 'unchanged')
    AND EXISTS (
      SELECT 1 FROM egress_messages AS reply
      WHERE reply.trace_id = stream.trace_id
        AND reply.purpose = 'reply'
        AND reply.state = 'delivered'
    )
    AND NOT EXISTS (
      SELECT 1 FROM egress_messages AS egress
      WHERE egress.trace_id = stream.trace_id
        AND (
          egress.purpose IN ('failure', 'voice_failure')
          OR egress.state IN (
            'prepared', 'attempting', 'accepted', 'acceptance_unknown', 'delivery_unknown'
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM jobs AS job
      WHERE job.trace_id = stream.trace_id
        AND job.status IN ('pending', 'running')
        AND job.type <> 'memory_maintenance'
    )
    AND NOT EXISTS (
      SELECT 1 FROM write_intents AS intent
      WHERE intent.state IN ('prepared', 'attempting', 'ambiguous')
        AND (
          intent.run_id = run.id
          OR intent.egress_id IN (
            SELECT egress.id FROM egress_messages AS egress WHERE egress.trace_id = stream.trace_id
          )
        )
    )
`;

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}
