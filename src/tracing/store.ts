import type Database from "better-sqlite3";
import type { TraceId } from "../core/ids.js";
import type { TraceRedactor } from "./redaction.js";

export interface TraceEventInput {
  traceId: TraceId;
  component: string;
  event: string;
  outcome?: string | undefined;
  providerRequestId?: string | undefined;
  jobId?: string | undefined;
  runId?: string | undefined;
  toolExecutionId?: string | undefined;
  writeIntentId?: string | undefined;
  data?: unknown;
  occurredAtMs?: number;
}

export interface TraceEventRecord {
  traceId: TraceId;
  sequence: number;
  occurredAtMs: number;
  component: string;
  event: string;
  outcome: string | null;
  providerRequestId: string | null;
  jobId: string | null;
  runId: string | null;
  toolExecutionId: string | null;
  writeIntentId: string | null;
  data: unknown;
}

interface SequenceRow {
  sequence: number;
}

interface SpoolRow {
  trace_id: TraceId;
  sequence: number;
  occurred_at_ms: number;
  component: string;
  event: string;
  outcome: string | null;
  provider_request_id: string | null;
  job_id: string | null;
  run_id: string | null;
  tool_execution_id: string | null;
  write_intent_id: string | null;
  redacted_json: string;
}

export class TraceStore {
  readonly #db: Database.Database;
  readonly #redactor: TraceRedactor;
  readonly #maxEvents: number;

  constructor(db: Database.Database, redactor: TraceRedactor, maxEvents = 2_048) {
    this.#db = db;
    this.#redactor = redactor;
    this.#maxEvents = maxEvents;
  }

  append(input: TraceEventInput): number {
    const transaction = this.#db.transaction(() => this.appendInTransaction(input));
    return transaction.immediate();
  }

  appendInTransaction(input: TraceEventInput): number {
    const now = input.occurredAtMs ?? Date.now();
    const relativePath = traceFileName(input.traceId);
    this.#db
      .prepare<{
        trace_id: string;
        now_ms: number;
      }>(`
        INSERT INTO trace_streams(
          trace_id, run_id, next_sequence, state, event_count, created_at_ms, updated_at_ms
        ) VALUES (@trace_id, NULL, 1, 'open', 0, @now_ms, @now_ms)
        ON CONFLICT(trace_id) DO NOTHING
      `)
      .run({ trace_id: input.traceId, now_ms: now });
    this.#db
      .prepare<{ trace_id: string; path: string; now_ms: number }>(`
        INSERT INTO trace_exports(
          trace_id, relative_path, exported_sequence, file_digest, finalized_at_ms, updated_at_ms
        ) VALUES (@trace_id, @path, 0, NULL, NULL, @now_ms)
        ON CONFLICT(trace_id) DO NOTHING
      `)
      .run({ trace_id: input.traceId, path: relativePath, now_ms: now });

    const sequence = this.#db
      .prepare<
        { trace_id: string; now_ms: number; max_events: number },
        SequenceRow
      >(`
        UPDATE trace_streams
        SET next_sequence = next_sequence + 1,
            event_count = event_count + 1,
            state = CASE WHEN state = 'exported' THEN 'terminal' ELSE state END,
            updated_at_ms = @now_ms
        WHERE trace_id = @trace_id
          AND event_count < @max_events
        RETURNING next_sequence - 1 AS sequence
      `)
      .get({ trace_id: input.traceId, now_ms: now, max_events: this.#maxEvents });
    if (sequence === undefined) {
      throw new Error(`Trace ${input.traceId} reached its ${this.#maxEvents}-event limit`);
    }

    this.#db
      .prepare<{
        trace_id: string;
        sequence: number;
        occurred_at_ms: number;
        component: string;
        event: string;
        outcome: string | null;
        provider_request_id: string | null;
        job_id: string | null;
        run_id: string | null;
        tool_execution_id: string | null;
        write_intent_id: string | null;
        redacted_json: string;
      }>(`
        INSERT INTO trace_event_spool(
          trace_id, sequence, occurred_at_ms, component, event, outcome,
          provider_request_id, job_id, run_id, tool_execution_id, write_intent_id,
          redacted_json
        ) VALUES (
          @trace_id, @sequence, @occurred_at_ms, @component, @event, @outcome,
          @provider_request_id, @job_id, @run_id, @tool_execution_id, @write_intent_id,
          @redacted_json
        )
      `)
      .run({
        trace_id: input.traceId,
        sequence: sequence.sequence,
        occurred_at_ms: now,
        component: input.component,
        event: input.event,
        outcome: input.outcome ?? null,
        provider_request_id: input.providerRequestId ?? null,
        job_id: input.jobId ?? null,
        run_id: input.runId ?? null,
        tool_execution_id: input.toolExecutionId ?? null,
        write_intent_id: input.writeIntentId ?? null,
        redacted_json: this.#redactor.stringify(input.data ?? {}),
      });
    return sequence.sequence;
  }

  bindRun(traceId: TraceId, runId: string): void {
    const result = this.#db
      .prepare<{ trace_id: string; run_id: string; now_ms: number }>(`
        UPDATE trace_streams
        SET run_id = @run_id, updated_at_ms = @now_ms
        WHERE trace_id = @trace_id AND (run_id IS NULL OR run_id = @run_id)
      `)
      .run({ trace_id: traceId, run_id: runId, now_ms: Date.now() });
    if (result.changes !== 1) {
      throw new Error(`Trace ${traceId} is already bound to another run`);
    }
  }

  markTerminal(traceId: TraceId): void {
    const result = this.#db
      .prepare<{ trace_id: string; now_ms: number }>(`
        UPDATE trace_streams
        SET state = 'terminal', updated_at_ms = @now_ms
        WHERE trace_id = @trace_id
      `)
      .run({ trace_id: traceId, now_ms: Date.now() });
    if (result.changes !== 1) {
      throw new Error(`Unknown trace: ${traceId}`);
    }
  }

  list(traceId: TraceId): TraceEventRecord[] {
    const rows = this.#db
      .prepare<{ trace_id: string }, SpoolRow>(`
        SELECT * FROM trace_event_spool
        WHERE trace_id = @trace_id
        ORDER BY sequence
      `)
      .all({ trace_id: traceId });
    return rows.map(toTraceEvent);
  }

  listTraceIdsNeedingExport(): TraceId[] {
    const rows = this.#db
      .prepare<[], { trace_id: TraceId }>(`
        SELECT stream.trace_id
        FROM trace_streams AS stream
        JOIN trace_exports AS exported USING (trace_id)
        WHERE exported.exported_sequence < stream.event_count
        ORDER BY stream.updated_at_ms
      `)
      .all();
    return rows.map((row) => row.trace_id);
  }
}

function toTraceEvent(row: SpoolRow): TraceEventRecord {
  return {
    traceId: row.trace_id,
    sequence: row.sequence,
    occurredAtMs: row.occurred_at_ms,
    component: row.component,
    event: row.event,
    outcome: row.outcome,
    providerRequestId: row.provider_request_id,
    jobId: row.job_id,
    runId: row.run_id,
    toolExecutionId: row.tool_execution_id,
    writeIntentId: row.write_intent_id,
    data: JSON.parse(row.redacted_json) as unknown,
  };
}

export function traceFileName(traceId: TraceId): string {
  if (!/^tr_[a-f0-9]{32}$/u.test(traceId)) {
    throw new Error(`Invalid trace ID: ${traceId}`);
  }
  return `${traceId}.jsonl`;
}
