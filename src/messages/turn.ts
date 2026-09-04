import type Database from "better-sqlite3";
import type { AgentLoop } from "../agent/loop.js";
import type { ModelMessage } from "../agent/model.js";
import type { ConversationHistoryStore } from "../agent/history.js";
import type { AgentRunRecord, AgentRunStore } from "../agent/store.js";
import { buildAssistantSystemPrompt } from "../agent/prompt.js";
import type { RuntimeConfig } from "../config.js";
import type { ConnectionRecoveryService } from "../connections/recovery.js";
import type { ConnectionStore } from "../connections/store.js";
import { parseConnectToolArguments } from "../connections/tools.js";
import { toSafeConnectionView, type ConnectionProvider } from "../connections/types.js";
import { asInboundId, type InboundId, type RunId, type TraceId } from "../core/ids.js";
import type { MemoryDocumentStore } from "../memory/document.js";
import type { ClaimedJob } from "../queue/store.js";
import type { JobContext } from "../queue/worker.js";
import type { TraceStore } from "../tracing/store.js";
import type { MessageEgressService } from "./egress.js";
import type { FailureNotificationService } from "./failure.js";

interface InboundTurnRow {
  id: InboundId;
  text: string | null;
  guid: string;
  state: "waiting_transcription" | "ready" | "processing" | "done" | "rejected" | "blocked";
  trace_id: TraceId;
  sequence: number;
}

/**
 * Runs one inbound message as an ordinary durable model/tool turn.
 *
 * The model interprets the request. Provider adapters enforce their account,
 * source, and dispatch boundaries; this service never inspects request or reply wording.
 */
export class InboundTurnService {
  readonly #db: Database.Database;
  readonly #config: RuntimeConfig;
  readonly #agent: AgentLoop;
  readonly #runs: AgentRunStore;
  readonly #history: ConversationHistoryStore;
  readonly #memory: MemoryDocumentStore;
  readonly #connections: ConnectionStore;
  readonly #recovery: ConnectionRecoveryService;
  readonly #egress: MessageEgressService;
  readonly #failures: FailureNotificationService;
  readonly #traces: TraceStore;

  constructor(input: {
    db: Database.Database;
    config: RuntimeConfig;
    agent: AgentLoop;
    runs: AgentRunStore;
    history: ConversationHistoryStore;
    memory: MemoryDocumentStore;
    connections: ConnectionStore;
    recovery: ConnectionRecoveryService;
    egress: MessageEgressService;
    failures: FailureNotificationService;
    traces: TraceStore;
  }) {
    this.#db = input.db;
    this.#config = input.config;
    this.#agent = input.agent;
    this.#runs = input.runs;
    this.#history = input.history;
    this.#memory = input.memory;
    this.#connections = input.connections;
    this.#recovery = input.recovery;
    this.#egress = input.egress;
    this.#failures = input.failures;
    this.#traces = input.traces;
  }

  async handle(job: ClaimedJob, context: JobContext): Promise<void> {
    if (job.type !== "inbound") {
      throw new Error(`InboundTurnService cannot handle ${job.type}`);
    }
    const payload = inboundPayload(job.payload);
    const inbound = this.#getInbound(payload.inboundId);
    if (inbound.id !== job.subjectId || inbound.trace_id !== job.traceId) {
      throw new Error("Inbound job identity does not match its message");
    }
    if (inbound.state === "blocked") {
      return;
    }
    if (
      inbound.state !== "ready" &&
      inbound.state !== "processing" &&
      inbound.state !== "done"
    ) {
      throw new Error(`Inbound ${inbound.id} cannot run from ${inbound.state}`);
    }
    const userMessage = inbound.text?.trim() ?? "";
    context.assertLease();
    try {
      if (inbound.state === "done") {
        this.#finishAlreadyCompletedTurn(inbound);
        return;
      }
      if (userMessage.length === 0) {
        this.#blockWithoutRun(inbound, "missing_text");
        this.#failures.plan({
          traceId: inbound.trace_id,
          failureCode: "missing_text",
          replyToGuid: inbound.guid,
        });
        return;
      }
      const memory = await this.#memory.load();
      const history = this.#history.loadBefore(inbound.id);
      const initialMessages: readonly ModelMessage[] = [
        { role: "system", content: this.#systemPrompt(memory) },
        ...history,
        { role: "user", content: userMessage },
      ];
      const result = await this.#agent.execute({
        source: { kind: "inbound", inboundId: inbound.id },
        traceId: inbound.trace_id,
        initialMessages,
        toolCallGuard: (call) =>
          this.#connectionToolCallRejection(inbound.id, call.name, call.id),
        jobLease: { jobId: job.id, leaseToken: job.leaseToken },
      });
      context.assertLease();
      if (result.outcome !== "completed") {
        this.#failures.plan({
          traceId: inbound.trace_id,
          failureCode: result.run.failureCode ?? "bounded",
          runId: result.run.id,
          replyToGuid: inbound.guid,
        });
        return;
      }
      const connectionProvider = this.#connectionRequestForRun(result.run.id);
      if (connectionProvider !== undefined) {
        this.#fulfillConnectTool(
          inbound,
          result.run.id,
          connectionProvider,
          result.response,
        );
        return;
      }
      this.#finishCompletedTurn(inbound, result.run.id, result.response);
    } catch (error) {
      context.assertLease();
      const run = this.#runForInbound(inbound.id);
      if (run !== undefined && (run.phase === "running" || run.phase === "finalizing")) {
        this.#runs.fail(run.id, "unhandled_turn_failure");
      } else if (run === undefined) {
        this.#blockWithoutRun(inbound, "unhandled_turn_failure");
      }
      this.#traces.append({
        traceId: inbound.trace_id,
        component: "agent",
        event: "turn_failed",
        outcome: error instanceof Error ? error.name : "UnknownError",
        runId: run?.id,
        data: { error: error instanceof Error ? error.message : "Unknown turn failure" },
      });
      this.#failures.plan({
        traceId: inbound.trace_id,
        failureCode: "unhandled_turn_failure",
        ...(run === undefined ? {} : { runId: run.id }),
        replyToGuid: inbound.guid,
      });
    }
  }

  /**
   * Closes the reply gap left by a crash between completing a run and planning
   * its reply. Both branches are idempotent, so the recovered turn plans at
   * most one message.
   */
  #finishAlreadyCompletedTurn(inbound: InboundTurnRow): void {
    const completed = this.#runForInbound(inbound.id);
    if (completed === undefined) {
      return;
    }
    if (completed.phase !== "completed" || completed.finalResponse === null) {
      throw new Error(`Done inbound ${inbound.id} has no completed response`);
    }
    const connectionProvider = this.#connectionRequestForRun(completed.id);
    if (connectionProvider !== undefined) {
      this.#fulfillConnectTool(
        inbound,
        completed.id,
        connectionProvider,
        completed.finalResponse,
      );
      return;
    }
    this.#finishCompletedTurn(inbound, completed.id, completed.finalResponse);
  }

  #finishCompletedTurn(
    inbound: InboundTurnRow,
    runId: RunId,
    finalResponse: string,
  ): void {
    this.#egress.planReply({
      traceId: inbound.trace_id,
      recipient: this.#config.userPhoneNumber,
      runId,
      replyToGuid: inbound.guid,
      text: finalResponse,
      inboundSequence: inbound.sequence,
    });
  }

  #fulfillConnectTool(
    inbound: InboundTurnRow,
    runId: RunId,
    provider: ConnectionProvider,
    message: string,
  ): void {
    const transaction = this.#db.transaction(() => {
      const handled = this.#db
        .prepare<
          { run_id: string; trace_id: string },
          { handled: number }
        >(`
          SELECT 1 AS handled
          FROM trace_event_spool
          WHERE run_id = @run_id
            AND trace_id = @trace_id
            AND component = 'connection_control'
            AND event = 'connect_fulfilled'
          LIMIT 1
        `)
        .get({ run_id: runId, trace_id: inbound.trace_id });
      if (handled !== undefined) {
        return;
      }

      this.#recovery.sendConnectLink(provider, inbound.trace_id, runId, message);
      this.#traces.appendInTransaction({
        traceId: inbound.trace_id,
        component: "connection_control",
        event: "connect_fulfilled",
        outcome: provider,
        runId,
        data: { inboundId: inbound.id },
      });
    });
    transaction.immediate();
  }

  #connectionToolCallRejection(
    inboundId: InboundId,
    toolName: string,
    toolCallId: string,
  ): string | undefined {
    const run = this.#runForInbound(inboundId);
    if (run === undefined) {
      throw new Error(`Inbound ${inboundId} has no agent run`);
    }
    if (this.#toolCallWasPrepared(run.id, toolCallId)) {
      return undefined;
    }
    if (this.#hasConnectToolCall(run.id)) {
      return "No tool call may follow connections.connect";
    }
    if (toolName !== "connections.connect") {
      return undefined;
    }
    return run.modelRequests === 1 && run.toolCalls === 0
      ? undefined
      : "connections.connect is allowed only in the first model response";
  }

  #connectionRequestForRun(runId: RunId): ConnectionProvider | undefined {
    const rows = this.#db
      .prepare<{ run_id: string }, { arguments_json: string }>(`
        SELECT arguments_json FROM tool_executions
        WHERE run_id = @run_id
          AND tool_name = 'connections.connect'
          AND status = 'succeeded'
        ORDER BY created_at_ms, id
      `)
      .all({ run_id: runId });
    if (rows.length > 1) {
      throw new Error(`Agent run ${runId} contains multiple successful connection requests`);
    }
    return rows[0] === undefined
      ? undefined
      : parseConnectToolArguments(rows[0].arguments_json).provider;
  }

  #hasConnectToolCall(runId: RunId): boolean {
    return (
      this.#db
        .prepare<{ run_id: string }, { found: number }>(`
          SELECT 1 AS found FROM tool_executions
          WHERE run_id = @run_id AND tool_name = 'connections.connect'
          LIMIT 1
        `)
        .get({ run_id: runId }) !== undefined
    );
  }

  #toolCallWasPrepared(runId: RunId, toolCallId: string): boolean {
    return (
      this.#db
        .prepare<{ run_id: string; tool_call_id: string }, { found: number }>(`
          SELECT 1 AS found FROM tool_executions
          WHERE run_id = @run_id AND tool_call_id = @tool_call_id
        `)
        .get({ run_id: runId, tool_call_id: toolCallId }) !== undefined
    );
  }


  #blockWithoutRun(inbound: InboundTurnRow, failureCode: string): void {
    const transaction = this.#db.transaction(() => {
      this.#db
        .prepare<{ id: string; now_ms: number }>(`
          UPDATE inbound_messages SET state = 'blocked', updated_at_ms = @now_ms
          WHERE id = @id AND state IN ('ready', 'processing')
        `)
        .run({ id: inbound.id, now_ms: Date.now() });
      this.#traces.appendInTransaction({
        traceId: inbound.trace_id,
        component: "agent",
        event: "blocked",
        outcome: failureCode,
        data: { inboundId: inbound.id },
      });
    });
    transaction.immediate();
  }

  #getInbound(inboundId: InboundId): InboundTurnRow {
    const row = this.#db
      .prepare<{ id: string }, InboundTurnRow>(`
        SELECT id, text, guid, state, trace_id, sequence
        FROM inbound_messages WHERE id = @id
      `)
      .get({ id: inboundId });
    if (row === undefined) {
      throw new Error(`Unknown inbound message: ${inboundId}`);
    }
    return row;
  }

  #runForInbound(inboundId: InboundId): AgentRunRecord | undefined {
    const row = this.#db
      .prepare<{ inbound_id: string }, { id: RunId }>(`
        SELECT id FROM agent_runs WHERE inbound_id = @inbound_id
      `)
      .get({ inbound_id: inboundId });
    return row === undefined ? undefined : this.#runs.getRequired(row.id);
  }

  #systemPrompt(memory: string): string {
    return buildAssistantSystemPrompt({
      memory,
      audience: {
        kind: "inbound",
        connections: this.#connections.list().map(toSafeConnectionView),
      },
    });
  }
}

function inboundPayload(value: unknown): { inboundId: InboundId } {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("inboundId" in value) ||
    typeof value.inboundId !== "string"
  ) {
    throw new Error("Inbound job payload is invalid");
  }
  return { inboundId: asInboundId(value.inboundId) };
}
