import type Database from "better-sqlite3";
import type { AgentLoop } from "../agent/loop.js";
import type { ModelMessage } from "../agent/model.js";
import type { ConversationHistoryStore } from "../agent/history.js";
import type { AgentRunRecord, AgentRunStore } from "../agent/store.js";
import { buildAssistantSystemPrompt } from "../agent/prompt.js";
import type { RuntimeConfig } from "../config.js";
import type { ConnectionRecoveryService } from "../connections/recovery.js";
import type { ConnectionStore } from "../connections/store.js";
import {
  explicitConnectRequestProvider,
  parseConnectToolArguments,
} from "../connections/tools.js";
import { toSafeConnectionView, type ConnectionProvider } from "../connections/types.js";
import { asInboundId, type InboundId, type RunId, type TraceId } from "../core/ids.js";
import type { MemoryDocumentStore } from "../memory/document.js";
import type { ClaimedJob } from "../queue/store.js";
import type { JobContext } from "../queue/worker.js";
import type { TraceStore } from "../tracing/store.js";
import type { MessageEgressService } from "./egress.js";
import type { FailureNotificationService } from "./failure.js";

const explicitConnectToolCallId = "explicit_connection_request";

interface InboundTurnRow {
  id: InboundId;
  text: string | null;
  guid: string;
  state: "waiting_transcription" | "ready" | "processing" | "done" | "rejected" | "blocked";
  trace_id: TraceId;
  sequence: number;
}

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
        const completed = this.#runForInbound(inbound.id);
        if (completed === undefined) {
          return;
        }
        if (completed.phase !== "completed" || completed.finalResponse === null) {
          throw new Error(`Done inbound ${inbound.id} has no completed response`);
        }
        const connectionRequest = this.#connectionRequestForRun(completed.id);
        if (connectionRequest !== undefined) {
          if (
            completed.modelRequests === 0 &&
            connectionRequest.toolCallId === explicitConnectToolCallId
          ) {
            const authorizedProvider = explicitConnectRequestProvider(userMessage);
            const action = explicitConnectAction(connectionRequest.provider);
            if (
              authorizedProvider !== connectionRequest.provider ||
              completed.finalResponse !== action.response
            ) {
              throw new Error(
                `Explicit connection run ${completed.id} completed with inconsistent state`,
              );
            }
            this.#runs.appendInfrastructureToolTurn({
              runId: completed.id,
              authorizationMessage: userMessage,
              call: action.call,
              result: action.result,
              completion: action.response,
            });
          }
          this.#fulfillConnectTool(
            inbound,
            completed.id,
            connectionRequest.provider,
            completed.finalResponse,
          );
          return;
        }
        this.#finishCompletedTurn(
          inbound,
          completed.id,
          completed.finalResponse,
        );
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
      const explicitConnectProvider = explicitConnectRequestProvider(userMessage);
      if (explicitConnectProvider !== undefined) {
        this.#fulfillExplicitConnectRequest(
          inbound,
          job,
          explicitConnectProvider,
          userMessage,
          initialMessages,
        );
        return;
      }
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
      const connectionRequest = this.#connectionRequestForRun(result.run.id);
      if (connectionRequest !== undefined) {
        this.#fulfillConnectTool(
          inbound,
          result.run.id,
          connectionRequest.provider,
          result.response,
        );
        return;
      }
      this.#finishCompletedTurn(
        inbound,
        result.run.id,
        result.response,
      );
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

  #fulfillExplicitConnectRequest(
    inbound: InboundTurnRow,
    job: ClaimedJob,
    provider: ConnectionProvider,
    authorizationMessage: string,
    initialMessages: readonly ModelMessage[],
  ): void {
    const run = this.#runs.startOrResume({
      source: { kind: "inbound", inboundId: inbound.id },
      traceId: inbound.trace_id,
      deadlineAtMs: Date.now() + this.#config.limits.maxAgentRunMs,
    });
    this.#runs.bindJob(run.id, job.id, job.leaseToken);
    this.#runs.appendInitialMessages(run.id, initialMessages);
    const { call, result, response } = explicitConnectAction(provider);
    if (run.phase === "completed") {
      const completedRequest = this.#connectionRequestForRun(run.id);
      if (
        run.modelRequests !== 0 ||
        run.finalResponse !== response ||
        completedRequest === undefined ||
        completedRequest.provider !== provider ||
        completedRequest.toolCallId !== call.id
      ) {
        throw new Error(`Explicit connection run ${run.id} completed with inconsistent state`);
      }
      this.#runs.appendInfrastructureToolTurn({
        runId: run.id,
        authorizationMessage,
        call,
        result,
        completion: response,
      });
      this.#fulfillConnectTool(inbound, run.id, provider, response);
      return;
    }
    if (run.phase !== "running") {
      throw new Error(`Explicit connection run ${run.id} cannot resume from ${run.phase}`);
    }

    let execution = this.#runs.prepareTool({
      runId: run.id,
      call,
      operationClass: "read",
      maximumToolCalls: this.#config.limits.maxAgentToolCalls,
    });
    if (execution.status === "validated") {
      this.#runs.markToolRunning(execution.id);
    }
    if (execution.status === "validated" || execution.status === "running") {
      execution = this.#runs.finishTool(execution.id, "succeeded", result);
    }
    if (execution.status !== "succeeded") {
      throw new Error(`Explicit connection tool cannot resume from ${execution.status}`);
    }

    this.#runs.appendInfrastructureToolTurn({
      runId: run.id,
      authorizationMessage,
      call,
      result,
      completion: response,
    });
    this.#runs.complete(run.id, response);
    this.#fulfillConnectTool(inbound, run.id, provider, response);
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

  #connectionRequestForRun(
    runId: RunId,
  ): { provider: ConnectionProvider; toolCallId: string } | undefined {
    const rows = this.#db
      .prepare<{ run_id: string }, { arguments_json: string; tool_call_id: string }>(`
        SELECT arguments_json, tool_call_id FROM tool_executions
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
      : {
          provider: parseConnectToolArguments(rows[0].arguments_json).provider,
          toolCallId: rows[0].tool_call_id,
        };
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

function explicitConnectAction(provider: ConnectionProvider) {
  return {
    call: {
      id: explicitConnectToolCallId,
      name: "connections.connect",
      argumentsJson: JSON.stringify({ provider }),
    },
    result: {
      provider,
      connectionLinkWillBeAppended: true,
    },
    response: `here's your new ${provider} connection link:`,
  };
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
