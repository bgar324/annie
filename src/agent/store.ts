import type Database from "better-sqlite3";
import { canonicalJson } from "../core/json.js";
import {
  newRunId,
  newToolExecutionId,
  type ConnectionId,
  type InboundId,
  type JobId,
  type RunId,
  type ToolExecutionId,
  type TraceId,
} from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { ModelMessage, ModelResponse, ModelToolCall } from "./model.js";
import type { ToolOperationClass } from "./tools.js";
import type { RequestScope } from "./request-scope.js";

export type AgentRunPhase = "pending" | "running" | "finalizing" | "completed" | "failed" | "blocked";

export type AgentRunSource =
  | { kind: "inbound"; inboundId: InboundId }
  | { kind: "daily_brief"; jobId: JobId };

export interface AgentRunRecord {
  id: RunId;
  source: AgentRunSource;
  traceId: TraceId;
  phase: AgentRunPhase;
  modelRequests: number;
  toolCalls: number;
  providerWrites: number;
  deadlineAtMs: number;
  finalResponse: string | null;
  failureCode: string | null;
  requestScope: RequestScope | null;
}

export interface ToolExecutionRecord {
  id: ToolExecutionId;
  runId: RunId;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  connectionId: ConnectionId | null;
  operationClass: ToolOperationClass;
  status: "validated" | "running" | "succeeded" | "failed" | "ambiguous" | "not_executed";
  result: unknown;
}

interface RunRow {
  id: RunId;
  inbound_id: InboundId | null;
  scheduled_job_id: JobId | null;
  trace_id: TraceId;
  phase: AgentRunPhase;
  model_requests: number;
  tool_calls: number;
  provider_writes: number;
  deadline_at_ms: number;
  final_response: string | null;
  failure_code: string | null;
  request_scope: RequestScope | null;
}

interface MessageRow {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  provider_state: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
}

interface ToolRow {
  id: ToolExecutionId;
  run_id: RunId;
  tool_call_id: string;
  tool_name: string;
  arguments_json: string;
  connection_id: ConnectionId | null;
  operation_class: ToolOperationClass;
  status: ToolExecutionRecord["status"];
  result_json: string | null;
}

export class AgentRunStore {
  readonly #db: Database.Database;
  readonly #traces: TraceStore;

  constructor(db: Database.Database, traces: TraceStore) {
    this.#db = db;
    this.#traces = traces;
  }

  startOrResume(input: {
    source: AgentRunSource;
    traceId: TraceId;
    deadlineAtMs: number;
  }): AgentRunRecord {
    const transaction = this.#db.transaction(() => {
      const existing =
        input.source.kind === "inbound"
          ? this.#db
              .prepare<{ inbound_id: string }, RunRow>(
                `${runSelect} WHERE inbound_id = @inbound_id`,
              )
              .get({ inbound_id: input.source.inboundId })
          : this.#db
              .prepare<{ scheduled_job_id: string }, RunRow>(
                `${runSelect} WHERE scheduled_job_id = @scheduled_job_id`,
              )
              .get({ scheduled_job_id: input.source.jobId });
      if (existing !== undefined) {
        if (existing.trace_id !== input.traceId) {
          throw new Error("Agent run source is already bound to another trace");
        }
        return toRun(existing);
      }
      const now = Date.now();
      if (input.source.kind === "inbound") {
        const inbound = this.#db
          .prepare<{ id: string; now_ms: number }, { id: InboundId }>(`
            UPDATE inbound_messages
            SET state = 'processing', updated_at_ms = @now_ms
            WHERE id = @id AND state = 'ready'
            RETURNING id
          `)
          .get({ id: input.source.inboundId, now_ms: now });
        if (inbound === undefined) {
          throw new Error(`Inbound message ${input.source.inboundId} is not ready`);
        }
      } else {
        const scheduled = this.#db
          .prepare<
            { id: string; trace_id: string },
            { id: JobId }
          >(`
            SELECT id FROM jobs
            WHERE id = @id AND type = 'daily_brief' AND status = 'running'
              AND trace_id = @trace_id
          `)
          .get({ id: input.source.jobId, trace_id: input.traceId });
        if (scheduled === undefined) {
          throw new Error(`Daily brief job ${input.source.jobId} is not actively leased`);
        }
      }
      const runId = newRunId();
      this.#db
        .prepare<{
          id: string;
          inbound_id: string | null;
          scheduled_job_id: string | null;
          trace_id: string;
          deadline_at_ms: number;
          now_ms: number;
        }>(`
          INSERT INTO agent_runs(
            id, inbound_id, scheduled_job_id, trace_id, phase, model_requests,
            maintenance_requests, tool_calls, provider_writes, deadline_at_ms,
            transcript_bytes, memory_maintenance_status, memory_before_digest,
            memory_after_digest, ambiguous_write_id, final_response, failure_code,
            created_at_ms, updated_at_ms
          ) VALUES (
            @id, @inbound_id, @scheduled_job_id, @trace_id, 'running', 0,
            0, 0, 0, @deadline_at_ms, 0, 'pending', NULL, NULL, NULL, NULL,
            NULL, @now_ms, @now_ms
          )
        `)
        .run({
          id: runId,
          inbound_id: input.source.kind === "inbound" ? input.source.inboundId : null,
          scheduled_job_id: input.source.kind === "daily_brief" ? input.source.jobId : null,
          trace_id: input.traceId,
          deadline_at_ms: input.deadlineAtMs,
          now_ms: now,
        });
      this.#traces.bindRun(input.traceId, runId);
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "agent",
        event: "run_started",
        outcome: "running",
        runId,
        data: { source: input.source, deadlineAtMs: input.deadlineAtMs },
        occurredAtMs: now,
      });
      return this.getRequired(runId);
    });
    return transaction.immediate();
  }

  bindJob(runId: RunId, jobId: string, leaseToken: string): void {
    const result = this.#db
      .prepare<{ run_id: string; job_id: string; lease_token: string; now_ms: number }>(`
        UPDATE jobs SET run_id = @run_id, updated_at_ms = @now_ms
        WHERE id = @job_id AND status = 'running' AND lease_token = @lease_token
          AND (run_id IS NULL OR run_id = @run_id)
      `)
      .run({ run_id: runId, job_id: jobId, lease_token: leaseToken, now_ms: Date.now() });
    if (result.changes !== 1) {
      throw new Error("Cannot bind an agent run without the active job lease");
    }
  }

  getRequired(runId: RunId): AgentRunRecord {
    const row = this.#db
      .prepare<{ id: string }, RunRow>(`${runSelect} WHERE id = @id`)
      .get({ id: runId });
    if (row === undefined) {
      throw new Error(`Unknown agent run: ${runId}`);
    }
    return toRun(row);
  }

  beginModelRequest(runId: RunId, maximum: number, nowMs = Date.now()): number {
    const row = this.#db
      .prepare<
        { id: string; maximum: number; now_ms: number },
        { model_requests: number }
      >(`
        UPDATE agent_runs
        SET model_requests = model_requests + 1, updated_at_ms = @now_ms
        WHERE id = @id AND phase = 'running'
          AND model_requests < @maximum AND deadline_at_ms > @now_ms
        RETURNING model_requests
      `)
      .get({ id: runId, maximum, now_ms: nowMs });
    if (row === undefined) {
      throw new AgentLimitError("model_request_limit", "The model request or time limit was reached");
    }
    return row.model_requests;
  }

  setRequestScope(
    runId: RunId,
    scope: RequestScope,
    jobLease: { jobId: string; leaseToken: string },
  ): void {
    const transaction = this.#db.transaction(() => {
      const now = Date.now();
      const changed = this.#db.prepare<{
        id: string; scope: RequestScope; job_id: string; lease_token: string; now_ms: number;
      }>(`
        UPDATE agent_runs SET request_scope = @scope, updated_at_ms = @now_ms
        WHERE id = @id AND inbound_id IS NOT NULL AND phase = 'running'
          AND (request_scope IS NULL OR request_scope = @scope)
          AND EXISTS (
            SELECT 1 FROM jobs
            WHERE id = @job_id AND run_id = @id AND status = 'running'
              AND lease_token = @lease_token AND lease_expires_at_ms > @now_ms
          )
      `).run({
        id: runId, scope, job_id: jobLease.jobId,
        lease_token: jobLease.leaseToken, now_ms: now,
      });
      if (changed.changes !== 1) {
        throw new Error("Request scope cannot change or be assigned without the active lease");
      }
      this.#traces.appendInTransaction({
        traceId: this.getRequired(runId).traceId,
        runId,
        component: "request_scope",
        event: "assigned",
        outcome: scope,
        data: {},
      });
    });
    transaction.immediate();
  }

  appendInitialMessages(runId: RunId, messages: readonly ModelMessage[]): void {
    if (this.loadMessages(runId).length > 0) {
      return;
    }
    const transaction = this.#db.transaction(() => {
      for (const message of messages) {
        this.#appendMessageInTransaction(runId, message, {});
      }
    });
    transaction.immediate();
  }

  appendAssistant(runId: RunId, response: ModelResponse): void {
    const message: ModelMessage = {
      role: "assistant",
      content: response.content,
      ...(response.providerState === null
        ? {}
        : { providerState: response.providerState }),
      ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }),
    };
    const transaction = this.#db.transaction(() => {
      this.#appendMessageInTransaction(runId, message, {
        providerResponseId: response.id,
        finishReason: response.finishReason,
        usage: response.usage,
      });
      this.#traces.appendInTransaction({
        traceId: this.getRequired(runId).traceId,
        component: "agent",
        event: "assistant_message_saved",
        outcome: response.finishReason ?? "unknown",
        runId,
        data: {
          toolCallCount: response.toolCalls.length,
          contentBytes: Buffer.byteLength(response.content),
        },
      });
    });
    transaction.immediate();
  }

  appendToolMessage(runId: RunId, toolCallId: string, content: string): void {
    const transaction = this.#db.transaction(() => {
      this.#appendMessageInTransaction(
        runId,
        { role: "tool", content, toolCallId },
        {},
      );
    });
    transaction.immediate();
  }

  loadMessages(runId: RunId): readonly ModelMessage[] {
    return this.#db
      .prepare<{ run_id: string }, MessageRow>(`
        SELECT role, content, reasoning_content AS provider_state, tool_calls_json, tool_call_id
        FROM agent_messages WHERE run_id = @run_id ORDER BY sequence
      `)
      .all({ run_id: runId })
      .map(toModelMessage);
  }

  prepareTool(input: {
    runId: RunId;
    call: ModelToolCall;
    operationClass: ToolOperationClass;
    maximumToolCalls: number;
  }): ToolExecutionRecord {
    const transaction = this.#db.transaction(() => {
      const existing = this.#getToolByCall(input.runId, input.call.id);
      if (existing !== undefined) {
        if (
          existing.tool_name !== input.call.name ||
          existing.arguments_json !== input.call.argumentsJson ||
          existing.operation_class !== input.operationClass
        ) {
          throw new Error("A model reused a tool call ID with different contents");
        }
        return toTool(existing);
      }
      const now = Date.now();
      const counter = this.#db
        .prepare<
          { id: string; maximum: number; now_ms: number },
          { tool_calls: number }
        >(`
          UPDATE agent_runs
          SET tool_calls = tool_calls + 1, updated_at_ms = @now_ms
          WHERE id = @id AND phase = 'running' AND tool_calls < @maximum
          RETURNING tool_calls
        `)
        .get({ id: input.runId, maximum: input.maximumToolCalls, now_ms: now });
      if (counter === undefined) {
        throw new AgentLimitError("tool_call_limit", "The tool call limit was reached");
      }
      const id = newToolExecutionId();
      this.#db
        .prepare<{
          id: string;
          run_id: string;
          tool_call_id: string;
          tool_name: string;
          arguments_json: string;
          operation_class: ToolOperationClass;
          now_ms: number;
        }>(`
          INSERT INTO tool_executions(
            id, run_id, tool_call_id, tool_name, arguments_json, connection_id,
            operation_class, status, result_json, write_intent_id, created_at_ms, updated_at_ms
          ) VALUES (
            @id, @run_id, @tool_call_id, @tool_name, @arguments_json, NULL,
            @operation_class, 'validated', NULL, NULL, @now_ms, @now_ms
          )
        `)
        .run({
          id,
          run_id: input.runId,
          tool_call_id: input.call.id,
          tool_name: input.call.name,
          arguments_json: input.call.argumentsJson,
          operation_class: input.operationClass,
          now_ms: now,
        });
      return toTool(this.#getToolRequired(id));
    });
    return transaction.immediate();
  }

  getToolRequired(toolExecutionId: ToolExecutionId): ToolExecutionRecord {
    return toTool(this.#getToolRequired(toolExecutionId));
  }

  bindToolConnection(toolExecutionId: ToolExecutionId, connectionId: ConnectionId): void {
    const result = this.#db
      .prepare<{ id: string; connection_id: string; now_ms: number }>(`
        UPDATE tool_executions
        SET connection_id = @connection_id, updated_at_ms = @now_ms
        WHERE id = @id AND status IN ('validated', 'running')
          AND (connection_id IS NULL OR connection_id = @connection_id)
      `)
      .run({ id: toolExecutionId, connection_id: connectionId, now_ms: Date.now() });
    if (result.changes !== 1) {
      throw new Error("Tool execution is already bound to a different connection");
    }
  }

  markToolRunning(toolExecutionId: ToolExecutionId): void {
    const result = this.#db
      .prepare<{ id: string; now_ms: number }>(`
        UPDATE tool_executions SET status = 'running', updated_at_ms = @now_ms
        WHERE id = @id AND status = 'validated'
      `)
      .run({ id: toolExecutionId, now_ms: Date.now() });
    if (result.changes !== 1) {
      throw new Error("Tool execution cannot start from its current state");
    }
  }

  finishTool(
    toolExecutionId: ToolExecutionId,
    status: "succeeded" | "failed" | "ambiguous" | "not_executed",
    result: unknown,
  ): ToolExecutionRecord {
    const row = this.#db
      .prepare<{
        id: string;
        status: ToolExecutionRecord["status"];
        result_json: string;
        now_ms: number;
      }, ToolRow>(`
        UPDATE tool_executions
        SET status = @status, result_json = @result_json, updated_at_ms = @now_ms
        WHERE id = @id AND status IN ('validated', 'running')
        RETURNING id, run_id, tool_call_id, tool_name, arguments_json,
                  connection_id, operation_class, status, result_json
      `)
      .get({
        id: toolExecutionId,
        status,
        result_json: canonicalJson(result),
        now_ms: Date.now(),
      });
    if (row === undefined) {
      throw new Error("Tool execution cannot finish from its current state");
    }
    return toTool(row);
  }

  complete(runId: RunId, response: string): void {
    this.#finishRun(runId, "completed", response, null, "done");
  }

  fail(runId: RunId, failureCode: string): void {
    this.#finishRun(runId, "failed", null, failureCode, "blocked");
  }

  block(runId: RunId, failureCode: string): void {
    this.#finishRun(runId, "blocked", null, failureCode, "blocked");
  }

  #finishRun(
    runId: RunId,
    phase: "completed" | "failed" | "blocked",
    finalResponse: string | null,
    failureCode: string | null,
    inboundState: "done" | "blocked",
  ): void {
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      const run = this.getRequired(runId);
      const update = this.#db
        .prepare<{
          id: string;
          phase: AgentRunPhase;
          final_response: string | null;
          failure_code: string | null;
          now_ms: number;
        }>(`
          UPDATE agent_runs
          SET phase = @phase, final_response = @final_response,
              failure_code = @failure_code, updated_at_ms = @now_ms
          WHERE id = @id AND phase IN ('running', 'finalizing')
        `)
        .run({
          id: runId,
          phase,
          final_response: finalResponse,
          failure_code: failureCode,
          now_ms: now,
        });
      if (update.changes !== 1) {
        if (run.phase === phase) {
          return;
        }
        throw new Error(`Run ${runId} cannot transition to ${phase}`);
      }
      if (run.source.kind === "inbound") {
        this.#db
          .prepare<{ id: string; state: string; now_ms: number }>(`
            UPDATE inbound_messages SET state = @state, updated_at_ms = @now_ms WHERE id = @id
          `)
          .run({ id: run.source.inboundId, state: inboundState, now_ms: now });
      }
      this.#traces.appendInTransaction({
        traceId: run.traceId,
        component: "agent",
        event: phase,
        outcome: failureCode ?? "ok",
        runId,
        data: { responseBytes: finalResponse === null ? 0 : Buffer.byteLength(finalResponse) },
        occurredAtMs: now,
      });
    });
    transaction.immediate();
  }

  #appendMessageInTransaction(
    runId: RunId,
    message: ModelMessage,
    metadata: {
      providerResponseId?: string | null;
      finishReason?: string | null;
      usage?: unknown;
    },
  ): void {
    const sequence = this.#db
      .prepare<{ run_id: string }, { sequence: number }>(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM agent_messages WHERE run_id = @run_id
      `)
      .get({ run_id: runId });
    if (sequence === undefined) {
      throw new Error("Cannot allocate an agent transcript sequence");
    }
    const contentBytes = Buffer.byteLength(message.content);
    const providerState = message.role === "assistant" ? message.providerState ?? null : null;
    const toolCalls = message.role === "assistant" ? message.toolCalls ?? null : null;
    const toolCallId = message.role === "tool" ? message.toolCallId : null;
    const toolCallsJson = toolCalls === null ? null : canonicalJson(toolCalls);
    const byteCount =
      contentBytes +
      (providerState === null ? 0 : Buffer.byteLength(providerState)) +
      (toolCallsJson === null ? 0 : Buffer.byteLength(toolCallsJson));
    const now = Date.now();
    this.#db
      .prepare<{
        run_id: string;
        sequence: number;
        role: string;
        content: string;
        provider_state: string | null;
        tool_calls_json: string | null;
        tool_call_id: string | null;
        provider_response_id: string | null;
        finish_reason: string | null;
        usage_json: string | null;
        byte_count: number;
        now_ms: number;
      }>(`
        INSERT INTO agent_messages(
          run_id, sequence, role, content, reasoning_content, tool_calls_json,
          tool_call_id, provider_response_id, finish_reason, usage_json,
          byte_count, created_at_ms
        ) VALUES (
          @run_id, @sequence, @role, @content, @provider_state, @tool_calls_json,
          @tool_call_id, @provider_response_id, @finish_reason, @usage_json,
          @byte_count, @now_ms
        )
      `)
      .run({
        run_id: runId,
        sequence: sequence.sequence,
        role: message.role,
        content: message.content,
        provider_state: providerState,
        tool_calls_json: toolCallsJson,
        tool_call_id: toolCallId,
        provider_response_id: metadata.providerResponseId ?? null,
        finish_reason: metadata.finishReason ?? null,
        usage_json: metadata.usage === undefined ? null : canonicalJson(metadata.usage),
        byte_count: byteCount,
        now_ms: now,
      });
    this.#db
      .prepare<{ id: string; bytes: number; now_ms: number }>(`
        UPDATE agent_runs
        SET transcript_bytes = transcript_bytes + @bytes, updated_at_ms = @now_ms
        WHERE id = @id
      `)
      .run({ id: runId, bytes: byteCount, now_ms: now });
  }

  #getToolByCall(runId: RunId, toolCallId: string): ToolRow | undefined {
    return this.#db
      .prepare<{ run_id: string; tool_call_id: string }, ToolRow>(`
        SELECT id, run_id, tool_call_id, tool_name, arguments_json,
               connection_id, operation_class, status, result_json
        FROM tool_executions WHERE run_id = @run_id AND tool_call_id = @tool_call_id
      `)
      .get({ run_id: runId, tool_call_id: toolCallId });
  }

  #getToolRequired(id: ToolExecutionId): ToolRow {
    const row = this.#db
      .prepare<{ id: string }, ToolRow>(`
        SELECT id, run_id, tool_call_id, tool_name, arguments_json,
               connection_id, operation_class, status, result_json
        FROM tool_executions WHERE id = @id
      `)
      .get({ id });
    if (row === undefined) {
      throw new Error(`Unknown tool execution: ${id}`);
    }
    return row;
  }
}

export class AgentLimitError extends Error {
  readonly code:
    | "model_request_limit"
    | "tool_call_limit"
    | "tool_response_limit"
    | "tool_not_allowed"
    | "write_limit"
    | "round_limit"
    | "run_deadline";
  constructor(code: AgentLimitError["code"], message: string) {
    super(message);
    this.name = "AgentLimitError";
    this.code = code;
  }
}

const runSelect = `
  SELECT id, inbound_id, scheduled_job_id, trace_id, phase, model_requests, tool_calls,
         provider_writes, deadline_at_ms, final_response, failure_code, request_scope
  FROM agent_runs
`;

function toRun(row: RunRow): AgentRunRecord {
  const source: AgentRunSource =
    row.inbound_id !== null && row.scheduled_job_id === null
      ? { kind: "inbound", inboundId: row.inbound_id }
      : row.inbound_id === null && row.scheduled_job_id !== null
        ? { kind: "daily_brief", jobId: row.scheduled_job_id }
        : (() => {
            throw new Error(`Agent run ${row.id} has an invalid source`);
          })();
  return {
    id: row.id,
    source,
    traceId: row.trace_id,
    phase: row.phase,
    modelRequests: row.model_requests,
    toolCalls: row.tool_calls,
    providerWrites: row.provider_writes,
    deadlineAtMs: row.deadline_at_ms,
    finalResponse: row.final_response,
    failureCode: row.failure_code,
    requestScope: row.request_scope,
  };
}

function toModelMessage(row: MessageRow): ModelMessage {
  if (row.role === "assistant") {
    return {
      role: "assistant",
      content: row.content,
      ...(row.provider_state === null ? {} : { providerState: row.provider_state }),
      ...(row.tool_calls_json === null
        ? {}
        : { toolCalls: JSON.parse(row.tool_calls_json) as ModelToolCall[] }),
    };
  }
  if (row.role === "tool") {
    if (row.tool_call_id === null) {
      throw new Error("Stored tool messages require a tool call ID");
    }
    return { role: "tool", content: row.content, toolCallId: row.tool_call_id };
  }
  return { role: row.role, content: row.content };
}

function toTool(row: ToolRow): ToolExecutionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    argumentsJson: row.arguments_json,
    connectionId: row.connection_id,
    operationClass: row.operation_class,
    status: row.status,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
  };
}
