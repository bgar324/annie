import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "../core/json.js";
import {
  newWriteIntentId,
  type ToolExecutionId,
  type TraceId,
  type WriteIntentId,
} from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";

export type WriteKind =
  | "gmail_create_draft"
  | "gmail_send_draft"
  | "notion_create_page"
  | "notion_update_page"
  | "sendblue_send_message";

export type WriteState =
  | "prepared"
  | "attempting"
  | "succeeded"
  | "confirmed_failed"
  | "ambiguous"
  | "reconciled_succeeded"
  | "unresolved";

export interface WriteIntent {
  id: WriteIntentId;
  runId: string | null;
  toolExecutionId: string | null;
  egressId: string | null;
  connectionId: string | null;
  kind: WriteKind;
  state: WriteState;
  requestFingerprint: string;
  request: unknown;
  connectionGeneration: number | null;
  providerReference: unknown;
}

interface WriteRow {
  id: WriteIntentId;
  run_id: string | null;
  tool_execution_id: string | null;
  egress_id: string | null;
  connection_id: string | null;
  kind: WriteKind;
  state: WriteState;
  request_fingerprint: string;
  request_json: string;
  connection_generation: number | null;
  provider_reference_json: string | null;
}

export class WriteStore {
  readonly #db: Database.Database;
  readonly #traces: TraceStore;

  constructor(db: Database.Database, traces: TraceStore) {
    this.#db = db;
    this.#traces = traces;
  }

  prepare(input: {
    traceId: TraceId;
    kind: WriteKind;
    request: unknown;
    safeSummary: unknown;
    runId?: string;
    toolExecutionId?: string;
    egressId?: string;
    connectionId?: string;
    connectionGeneration?: number;
  }): WriteIntent {
    const transaction = this.#db.transaction(() => this.prepareInTransaction(input));
    return transaction.immediate();
  }

  prepareInTransaction(input: {
    traceId: TraceId;
    kind: WriteKind;
    request: unknown;
    safeSummary: unknown;
    runId?: string;
    toolExecutionId?: string;
    egressId?: string;
    connectionId?: string;
    connectionGeneration?: number;
  }): WriteIntent {
    if (input.runId === undefined && input.egressId === undefined) {
      throw new Error("A write intent needs either a run or egress owner");
    }
    const requestJson = canonicalJson(input.request);
    const requestFingerprint = createHash("sha256").update(requestJson).digest("hex");
    if (input.toolExecutionId !== undefined) {
      const existing = this.#db
        .prepare<{ tool_execution_id: string }, WriteRow>(`
          SELECT id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
                 request_fingerprint, request_json, connection_generation,
                 provider_reference_json
          FROM write_intents WHERE tool_execution_id = @tool_execution_id
        `)
        .get({ tool_execution_id: input.toolExecutionId });
      if (existing !== undefined) {
        if (
          existing.run_id !== (input.runId ?? null) ||
          existing.connection_id !== (input.connectionId ?? null) ||
          existing.kind !== input.kind ||
          existing.request_fingerprint !== requestFingerprint ||
          existing.connection_generation !== (input.connectionGeneration ?? null)
        ) {
          throw new Error("A tool execution cannot change its durable write intent");
        }
        return toWriteIntent(existing);
      }
    }
    const id = newWriteIntentId();
    const now = Date.now();
    const row = this.#db
      .prepare<{
        id: string;
        run_id: string | null;
        tool_execution_id: string | null;
        egress_id: string | null;
        connection_id: string | null;
        kind: WriteKind;
        request_fingerprint: string;
        safe_summary_json: string;
        request_json: string;
        connection_generation: number | null;
        now_ms: number;
      }, WriteRow>(`
        INSERT INTO write_intents(
          id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
          request_fingerprint, safe_summary_json, request_json, connection_generation,
          provider_reference_json, attempted_at_ms, completed_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          @id, @run_id, @tool_execution_id, @egress_id, @connection_id, @kind, 'prepared',
          @request_fingerprint, @safe_summary_json, @request_json, @connection_generation,
          NULL, NULL, NULL, @now_ms, @now_ms
        )
        RETURNING id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
                  request_fingerprint, request_json, connection_generation,
                  provider_reference_json
      `)
      .get({
        id,
        run_id: input.runId ?? null,
        tool_execution_id: input.toolExecutionId ?? null,
        egress_id: input.egressId ?? null,
        connection_id: input.connectionId ?? null,
        kind: input.kind,
        request_fingerprint: requestFingerprint,
        safe_summary_json: canonicalJson(input.safeSummary),
        request_json: requestJson,
        connection_generation: input.connectionGeneration ?? null,
        now_ms: now,
      });
    if (row === undefined) {
      throw new Error("Write intent insert returned no row");
    }
    if (input.toolExecutionId !== undefined) {
      this.#db
        .prepare<{ tool_execution_id: string; write_intent_id: string; now_ms: number }>(`
          UPDATE tool_executions
          SET write_intent_id = @write_intent_id, updated_at_ms = @now_ms
          WHERE id = @tool_execution_id AND write_intent_id IS NULL
        `)
        .run({ tool_execution_id: input.toolExecutionId, write_intent_id: id, now_ms: now });
    }
    this.#traces.appendInTransaction({
      traceId: input.traceId,
      component: "write",
      event: "prepared",
      outcome: input.kind,
      runId: input.runId,
      toolExecutionId: input.toolExecutionId,
      writeIntentId: id,
      data: {
        fingerprint: row.request_fingerprint,
        safeSummary: input.safeSummary,
      },
      occurredAtMs: now,
    });
    return toWriteIntent(row);
  }

  beginAttempt(input: {
    writeId: WriteIntentId;
    traceId: TraceId;
    jobLease?: { jobId: string; leaseToken: string; nowMs: number };
  }): WriteIntent {
    const transaction = this.#db.transaction(() => {
      if (input.jobLease !== undefined) {
        const owned = this.#db
          .prepare<
            { id: string; lease_token: string; now_ms: number },
            { owned: 1 }
          >(`
            SELECT 1 AS owned FROM jobs
            WHERE id = @id AND status = 'running' AND lease_token = @lease_token
              AND lease_expires_at_ms > @now_ms
          `)
          .get({
            id: input.jobLease.jobId,
            lease_token: input.jobLease.leaseToken,
            now_ms: input.jobLease.nowMs,
          });
        if (owned === undefined) {
          throw new Error("A provider write cannot begin without the current job lease");
        }
      }
      const now = Date.now();
      const row = this.#db
        .prepare<{ id: string; now_ms: number }, WriteRow>(`
          UPDATE write_intents
          SET state = 'attempting', attempted_at_ms = @now_ms, updated_at_ms = @now_ms
          WHERE id = @id AND state = 'prepared'
          RETURNING id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
                    request_fingerprint, request_json, connection_generation,
                    provider_reference_json
        `)
        .get({ id: input.writeId, now_ms: now });
      if (row === undefined) {
        throw new Error(`Write ${input.writeId} is not executable`);
      }
      if (row.run_id !== null) {
        this.#db
          .prepare<{ run_id: string; now_ms: number }>(`
            UPDATE agent_runs
            SET provider_writes = provider_writes + 1, updated_at_ms = @now_ms
            WHERE id = @run_id
          `)
          .run({ run_id: row.run_id, now_ms: now });
      }
      if (row.tool_execution_id !== null) {
        this.#db
          .prepare<{ id: string; now_ms: number }>(`
            UPDATE tool_executions
            SET status = 'running', updated_at_ms = @now_ms
            WHERE id = @id AND status = 'validated'
          `)
          .run({ id: row.tool_execution_id, now_ms: now });
      }
      if (row.egress_id !== null) {
        const egress = this.#db
          .prepare<{ id: string; now_ms: number }>(`
            UPDATE egress_messages
            SET state = 'attempting', attempt_count = 1, updated_at_ms = @now_ms
            WHERE id = @id AND state = 'prepared' AND attempt_count = 0
          `)
          .run({ id: row.egress_id, now_ms: now });
        if (egress.changes !== 1) {
          throw new Error(`Egress ${row.egress_id} is not executable`);
        }
      }
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "write",
        event: "attempting",
        outcome: row.kind,
        runId: row.run_id ?? undefined,
        toolExecutionId: row.tool_execution_id ?? undefined,
        writeIntentId: row.id,
        data: { fingerprint: row.request_fingerprint },
        occurredAtMs: now,
      });
      return toWriteIntent(row);
    });
    return transaction.immediate();
  }

  complete(input: {
    writeId: WriteIntentId;
    traceId: TraceId;
    state: Exclude<WriteState, "prepared" | "attempting">;
    normalizedResult: unknown;
    providerReference?: unknown;
  }): WriteIntent {
    const transaction = this.#db.transaction(() => this.completeInTransaction(input));
    return transaction.immediate();
  }

  completeInTransaction(input: {
    writeId: WriteIntentId;
    traceId: TraceId;
    state: Exclude<WriteState, "prepared" | "attempting">;
    normalizedResult: unknown;
    providerReference?: unknown;
  }): WriteIntent {
    const now = Date.now();
      const row = this.#db
        .prepare<{
          id: string;
          state: Exclude<WriteState, "prepared" | "attempting">;
          provider_reference_json: string | null;
          now_ms: number;
        }, WriteRow>(`
          UPDATE write_intents
          SET state = @state,
              provider_reference_json = @provider_reference_json,
              completed_at_ms = @now_ms,
              updated_at_ms = @now_ms
          WHERE id = @id AND state IN ('attempting', 'ambiguous')
          RETURNING id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
                    request_fingerprint, request_json, connection_generation,
                    provider_reference_json
        `)
        .get({
          id: input.writeId,
          state: input.state,
          provider_reference_json:
            input.providerReference === undefined ? null : canonicalJson(input.providerReference),
          now_ms: now,
        });
      if (row === undefined) {
        throw new Error(`Write ${input.writeId} cannot transition to ${input.state}`);
      }
      if (row.tool_execution_id !== null) {
        const toolStatus =
          input.state === "succeeded" || input.state === "reconciled_succeeded"
            ? "succeeded"
            : input.state === "ambiguous" || input.state === "unresolved"
              ? "ambiguous"
              : "failed";
        this.#db
          .prepare<{
            id: string;
            status: "succeeded" | "ambiguous" | "failed";
            result_json: string;
            now_ms: number;
          }>(`
            UPDATE tool_executions
            SET status = @status, result_json = @result_json, updated_at_ms = @now_ms
            WHERE id = @id
          `)
          .run({
            id: row.tool_execution_id,
            status: toolStatus,
            result_json: canonicalJson(input.normalizedResult),
            now_ms: now,
          });
      }
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "write",
        event: input.state,
        outcome: row.kind,
        runId: row.run_id ?? undefined,
        toolExecutionId: row.tool_execution_id ?? undefined,
        writeIntentId: row.id,
        data: input.normalizedResult,
        occurredAtMs: now,
      });
      return toWriteIntent(row);
  }

  get(writeId: WriteIntentId): WriteIntent | undefined {
    const row = this.#db
      .prepare<{ id: string }, WriteRow>(`
        SELECT id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
               request_fingerprint, request_json, connection_generation,
               provider_reference_json
        FROM write_intents WHERE id = @id
      `)
      .get({ id: writeId });
    return row === undefined ? undefined : toWriteIntent(row);
  }

  getByToolExecution(toolExecutionId: ToolExecutionId): WriteIntent | undefined {
    const row = this.#db
      .prepare<{ tool_execution_id: string }, WriteRow>(`
        SELECT id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
               request_fingerprint, request_json, connection_generation,
               provider_reference_json
        FROM write_intents WHERE tool_execution_id = @tool_execution_id
      `)
      .get({ tool_execution_id: toolExecutionId });
    return row === undefined ? undefined : toWriteIntent(row);
  }

  recoverOpenAttempts(): WriteIntentId[] {
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      const rows = this.#db
        .prepare<{ now_ms: number }, WriteRow>(`
          UPDATE write_intents
          SET state = 'ambiguous', completed_at_ms = @now_ms, updated_at_ms = @now_ms
          WHERE state = 'attempting'
          RETURNING id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
                    request_fingerprint, request_json, connection_generation,
                    provider_reference_json
        `)
        .all({ now_ms: now });
      for (const row of rows) {
        if (row.tool_execution_id !== null) {
          this.#db
            .prepare<{ id: string; now_ms: number }>(`
              UPDATE tool_executions
              SET status = 'ambiguous',
                  result_json = '{"error":{"code":"acceptance_unknown","message":"The provider may have accepted this write"},"ok":false}',
                  updated_at_ms = @now_ms
              WHERE id = @id
            `)
            .run({ id: row.tool_execution_id, now_ms: now });
        }
        if (row.run_id !== null) {
          this.#db
            .prepare<{ id: string; write_id: string; now_ms: number }>(`
              UPDATE agent_runs
              SET phase = 'blocked', ambiguous_write_id = @write_id,
                  failure_code = 'ambiguous_write', updated_at_ms = @now_ms
              WHERE id = @id AND phase NOT IN ('completed', 'failed')
            `)
            .run({ id: row.run_id, write_id: row.id, now_ms: now });
        }
        if (row.egress_id !== null) {
          this.#db
            .prepare<{ id: string; error: string; now_ms: number }>(`
              UPDATE egress_messages
              SET state = 'acceptance_unknown', last_error = @error, updated_at_ms = @now_ms
              WHERE id = @id AND state = 'attempting'
            `)
            .run({
              id: row.egress_id,
              error: "Provider acceptance is unknown after process interruption",
              now_ms: now,
            });
          this.#db
            .prepare<{ egress_id: string; now_ms: number }>(`
              UPDATE recovery_notices
              SET status = 'attempted', attempted_at_ms = @now_ms
              WHERE egress_id = @egress_id AND status = 'planned'
            `)
            .run({ egress_id: row.egress_id, now_ms: now });
        }
        const trace = this.#db
          .prepare<{ run_id: string | null; egress_id: string | null }, { trace_id: TraceId }>(`
            SELECT trace_id FROM agent_runs WHERE id = @run_id
            UNION ALL
            SELECT trace_id FROM egress_messages WHERE id = @egress_id
            LIMIT 1
          `)
          .get({ run_id: row.run_id, egress_id: row.egress_id });
        if (trace === undefined) {
          continue;
        }
        this.#traces.appendInTransaction({
          traceId: trace.trace_id,
          component: "write",
          event: "ambiguous",
          outcome: "recovered_open_attempt",
          runId: row.run_id ?? undefined,
          toolExecutionId: row.tool_execution_id ?? undefined,
          writeIntentId: row.id,
          data: { kind: row.kind },
          occurredAtMs: now,
        });
        if (row.egress_id !== null) {
          const job = this.#db
            .prepare<
              { egress_id: string; error: string; now_ms: number },
              { id: string; run_id: string | null }
            >(`
              UPDATE jobs
              SET status = 'blocked', lease_token = NULL, lease_expires_at_ms = NULL,
                  last_error = @error, updated_at_ms = @now_ms
              WHERE type = 'egress_send' AND subject_id = @egress_id
                AND status IN ('pending', 'running')
              RETURNING id, run_id
            `)
            .get({
              egress_id: row.egress_id,
              error: "Provider acceptance is unknown after process interruption",
              now_ms: now,
            });
          if (job !== undefined) {
            this.#traces.appendInTransaction({
              traceId: trace.trace_id,
              component: "queue",
              event: "blocked",
              outcome: "egress_send",
              jobId: job.id,
              runId: job.run_id ?? undefined,
              data: { error: "Provider acceptance is unknown after process interruption" },
              occurredAtMs: now,
            });
          }
          this.#traces.appendInTransaction({
            traceId: trace.trace_id,
            component: "egress",
            event: "acceptance_unknown",
            outcome: "recovered_open_attempt",
            runId: row.run_id ?? undefined,
            writeIntentId: row.id,
            data: {
              egressId: row.egress_id,
              error: "Provider acceptance is unknown after process interruption",
            },
            occurredAtMs: now,
          });
          this.#traces.markTerminal(trace.trace_id);
        }
      }
      return rows.map((row) => row.id);
    });
    return transaction.immediate();
  }
}

function toWriteIntent(row: WriteRow): WriteIntent {
  return {
    id: row.id,
    runId: row.run_id,
    toolExecutionId: row.tool_execution_id,
    egressId: row.egress_id,
    connectionId: row.connection_id,
    kind: row.kind,
    state: row.state,
    requestFingerprint: row.request_fingerprint,
    request: JSON.parse(row.request_json) as unknown,
    connectionGeneration: row.connection_generation,
    providerReference:
      row.provider_reference_json === null
        ? null
        : (JSON.parse(row.provider_reference_json) as unknown),
  };
}
