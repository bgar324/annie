import type Database from "better-sqlite3";
import type { AgentLoop } from "../agent/loop.js";
import type { ModelMessage, ModelToolCall } from "../agent/model.js";
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
type ProviderWriteScope = { workspace?: string };
type ProviderWriteAuthorization =
  | (ProviderWriteScope & { kind: "notion_create_page"; title: string; content?: string })
  | (ProviderWriteScope & {
      kind: "notion_update_property";
      property: string;
      value: string;
      pageTitle: string;
    })
  | (ProviderWriteScope & {
      kind: "notion_replace_content";
      content: string;
      pageTitle: string;
    })
  | (ProviderWriteScope & {
      kind: "notion_replace_text";
      oldText: string;
      newText: string;
      replaceAllMatches: boolean;
      pageTitle: string;
    })
  | (ProviderWriteScope & {
      kind: "notion_task_checkbox";
      checked: boolean;
      targetTokens: readonly string[];
    });
const taskTargetStopWords: ReadonlySet<string> = new Set([
  "a",
  "an",
  "as",
  "box",
  "checkbox",
  "it",
  "item",
  "my",
  "our",
  "task",
  "the",
  "this",
  "to",
  "todo",
]);
const taskLabelActionVerbs: ReadonlySet<string> = new Set([
  "add",
  "buy",
  "call",
  "clean",
  "create",
  "finish",
  "get",
  "make",
  "organize",
  "pull",
  "read",
  "review",
  "send",
  "update",
  "wash",
]);
const checkboxMarkerPattern = /\[(?: |x|X)\]/gu;
const agentWriteSuccessClaimPattern =
  /\b(?:i|we)(?:'ve| have| just)?\s+(?:successfully\s+)?(?:updated|changed|edited|saved|created|added|sent|scheduled|rescheduled|cancelled|canceled|removed|deleted|archived|renamed|marked)\b/u;
const agentDidWriteSuccessClaimPattern =
  /\b(?:i|we)\s+did\s+(?:successfully\s+)?(?:update|change|edit|save|create|add|send|schedule|reschedule|cancel|remove|delete|archive|rename|mark)\b/u;
const passiveWriteSuccessClaimPattern =
  /\b(?:(?:notion\s+)?(?:page|doc|document|task|checkbox|status)|(?:email\s+)?draft|message|event)\s+(?:has\s+been|was|is(?:\s+now)?)\s+(?:successfully\s+)?(?:updated|changed|edited|saved|created|added|sent|scheduled|rescheduled|cancelled|canceled|removed|deleted|archived|renamed|marked|checked)\b/u;
const providerStateSuccessClaimPattern =
  /\b(?:status|task|checkbox|item)\s+(?:is|are)\s+now\s+(?:done|complete|completed|checked(?:\s+off)?)\b/u;
const directProviderWriteRequestPattern =
  /^(?:please\s+)?(?:update|change|edit|save|create|add|send|schedule|reschedule|cancel|remove|delete|archive|rename|mark|check)\b|\b(?:can|could|would|will|did|have)\s+(?:you|u)\s+(?:please\s+)?(?:update|change|edit|save|create|add|send|schedule|reschedule|cancel|remove|delete|archive|rename|mark|check)\b|\b(?:are|were)\s+(?:you|u)\s+(?:currently\s+)?(?:updating|changing|editing|saving|creating|adding|sending|scheduling|rescheduling|cancelling|canceling|removing|deleting|archiving|renaming|marking|checking)\b/u;

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
    const providerWriteAuthorization = currentMessageProviderWriteAuthorization(userMessage);
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
        const completionRejection = this.#providerWriteCompletionRejection(
          completed.id,
          providerWriteAuthorization,
          userMessage,
          completed.finalResponse,
        );
        if (completionRejection !== undefined) {
          this.#quarantineRejectedCompletion(
            inbound,
            completed.id,
            completionRejection,
            job,
            context,
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
      const providerWriteGuard = this.#providerWriteToolCallGuard(
        inbound.id,
        providerWriteAuthorization,
      );
      const result = await this.#agent.execute({
        source: { kind: "inbound", inboundId: inbound.id },
        traceId: inbound.trace_id,
        initialMessages,
        toolCallGuard: (call, operationClass) =>
          this.#connectionToolCallRejection(inbound.id, call.name, call.id) ??
          providerWriteGuard(call, operationClass === "write"),
        toolCallBatchGuard: (calls) =>
          calls.filter(({ operationClass }) => operationClass === "write").length > 1
            ? "The current request authorizes at most one provider write"
            : undefined,
        completionGuard: ({ runId, response }) =>
          this.#providerWriteCompletionRejection(
            runId,
            providerWriteAuthorization,
            userMessage,
            response,
          ),
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

  #quarantineRejectedCompletion(
    inbound: InboundTurnRow,
    runId: RunId,
    failureCode: string,
    job: ClaimedJob,
    context: JobContext,
  ): void {
    context.assertLease();
    const nowMs = context.nowMs();
    const transaction = this.#db.transaction(() => {
      const suppression = this.#egress.suppressPreparedReplyInTransaction({
        traceId: inbound.trace_id,
        runId,
        reason: failureCode,
        job,
        nowMs,
      });
      this.#runs.quarantineCompletedInTransaction(runId, failureCode);
      const failure = {
        traceId: inbound.trace_id,
        failureCode,
        runId,
        replyToGuid: inbound.guid,
      };
      if (suppression.kind === "absent") {
        this.#failures.planInTransaction(failure);
      } else if (suppression.kind === "suppressed") {
        this.#failures.replaceSuppressedReplyInTransaction(
          failure,
          suppression.egressId,
        );
      }
    });
    transaction.immediate();
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

  #providerWriteToolCallGuard(
    inboundId: InboundId,
    authorization: ProviderWriteAuthorization | undefined,
  ): (call: ModelToolCall, isWrite: boolean) => string | undefined {
    const preparedWrites = this.#db
      .prepare<{ inbound_id: string }, { tool_call_id: string }>(`
        SELECT tools.tool_call_id
        FROM tool_executions AS tools
        JOIN agent_runs AS runs ON runs.id = tools.run_id
        WHERE runs.inbound_id = @inbound_id
          AND tools.operation_class = 'write'
        ORDER BY tools.created_at_ms, tools.id
        LIMIT 2
      `)
      .all({ inbound_id: inboundId });
    let authorizedCallId = preparedWrites[0]?.tool_call_id;
    const alreadyExceeded = preparedWrites.length > 1;
    return (call, isWrite) => {
      if (
        isWrite &&
        (alreadyExceeded ||
          (authorizedCallId !== undefined && authorizedCallId !== call.id))
      ) {
        return "The current request authorizes at most one provider write";
      }
      let rejection = providerWriteToolCallRejection(authorization, call, isWrite);
      if (rejection === undefined) {
        rejection = this.#unscopedWorkspaceRejection(authorization, call, isWrite);
      }
      if (rejection === undefined) {
        rejection = this.#notionWriteTargetRejection(
          inboundId,
          authorization,
          call,
          isWrite,
        );
      }
      if (isWrite && rejection === undefined) {
        authorizedCallId = call.id;
      }
      return rejection;
    };
  }

  #notionWriteTargetRejection(
    inboundId: InboundId,
    authorization: ProviderWriteAuthorization | undefined,
    call: ModelToolCall,
    isWrite: boolean,
  ): string | undefined {
    if (
      !isWrite ||
      authorization === undefined ||
      authorization.kind === "notion_create_page"
    ) {
      return undefined;
    }
    const argumentsValue = modelCallArguments(call);
    const pageId = argumentsValue?.pageId;
    if (
      call.name !== "notion.update_page" ||
      argumentsValue === undefined ||
      typeof pageId !== "string"
    ) {
      return "The provider write target was not established by a current search and fetch";
    }
    const run = this.#runForInbound(inboundId);
    if (run === undefined) {
      throw new Error(`Inbound ${inboundId} has no agent run`);
    }
    const fetches = this.#db
      .prepare<
        { run_id: string },
        { arguments_json: string; result_json: string }
      >(`
        SELECT arguments_json, result_json
        FROM tool_executions
        WHERE run_id = @run_id
          AND tool_name = 'notion.fetch'
          AND status = 'succeeded'
          AND result_json IS NOT NULL
        ORDER BY created_at_ms DESC, id DESC
      `)
      .all({ run_id: run.id });
    for (const fetch of fetches) {
      const fetchArguments = jsonRecord(fetch.arguments_json);
      const fetchResult = jsonRecord(fetch.result_json);
      const result = asRecord(fetchResult?.result);
      if (
        fetchArguments?.id !== pageId ||
        result === undefined ||
        result.truncated !== false
      ) {
        continue;
      }
      const workspace = argumentsValue.workspace;
      const fetchedWorkspace = asRecord(fetchResult?.workspace)?.label;
      if (
        typeof workspace !== "string" ||
        typeof fetchedWorkspace !== "string" ||
        fetchedWorkspace !== workspace.trim()
      ) {
        continue;
      }
      const pageTitle =
        authorization.kind === "notion_task_checkbox" ? undefined : authorization.pageTitle;
      if (!this.#notionPageWasDiscovered(run.id, pageId, workspace, pageTitle)) {
        continue;
      }
      if (
        authorization.kind === "notion_task_checkbox" ||
        authorization.kind === "notion_replace_text"
      ) {
        const update = Array.isArray(argumentsValue.updates)
          ? asRecord(argumentsValue.updates[0])
          : undefined;
        const oldText = update?.oldText;
        const fetchedText = result.text;
        if (typeof oldText !== "string" || typeof fetchedText !== "string") {
          continue;
        }
        const occurrences = exactOccurrenceCount(fetchedText, oldText);
        if (
          (authorization.kind === "notion_task_checkbox" &&
            matchingTaskCheckboxLabelCount(fetchedText, authorization.targetTokens) !== 1) ||
          (occurrences !== 1 &&
            !(
              authorization.kind === "notion_replace_text" &&
              authorization.replaceAllMatches &&
              occurrences > 0
            ))
        ) {
          continue;
        }
      }
      return undefined;
    }
    return "The provider write target was not established by a current search and fetch";
  }

  #notionPageWasDiscovered(
    runId: RunId,
    pageId: string,
    workspace: string,
    expectedPageTitle?: string,
  ): boolean {
    const searches = this.#db
      .prepare<
        { run_id: string },
        { arguments_json: string; result_json: string }
      >(`
        SELECT arguments_json, result_json
        FROM tool_executions
        WHERE run_id = @run_id
          AND tool_name = 'notion.search'
          AND status = 'succeeded'
          AND result_json IS NOT NULL
        ORDER BY created_at_ms, id
      `)
      .all({ run_id: runId });
    let pageDiscovered = false;
    const titleMatches = new Set<string>();
    for (const search of searches) {
      const payload = jsonRecord(search.result_json);
      if (asRecord(payload?.workspace)?.label !== workspace.trim()) {
        continue;
      }
      const searchResult = asRecord(payload?.result);
      if (expectedPageTitle === undefined) {
        const pageScopedSearches = searchResult?.pageScopedSearches;
        if (Array.isArray(pageScopedSearches)) {
          for (const candidate of pageScopedSearches) {
            const scoped = asRecord(candidate);
            const scopedResults = scoped?.results;
            if (
              scoped?.pageId === pageId &&
              scoped.truncated === false &&
              Array.isArray(scopedResults) &&
              scopedResults.some((result) => asRecord(result)?.id === pageId)
            ) {
              pageDiscovered = true;
            }
          }
        }
      }
      if (expectedPageTitle !== undefined) {
        const searchArguments = jsonRecord(search.arguments_json);
        if (
          typeof searchArguments?.query !== "string" ||
          normalizeIdentifier(searchArguments.query) !== normalizeIdentifier(expectedPageTitle)
        ) {
          continue;
        }
      }
      const results = searchResult?.results;
      if (searchResult?.truncated !== false || !Array.isArray(results)) {
        continue;
      }
      for (const result of results) {
        const reference = asRecord(result);
        if (typeof reference?.id !== "string") {
          continue;
        }
        pageDiscovered ||= reference.id === pageId;
        if (
          expectedPageTitle !== undefined &&
          typeof reference.title === "string" &&
          normalizeIdentifier(reference.title) === normalizeIdentifier(expectedPageTitle)
        ) {
          titleMatches.add(reference.id);
        }
      }
    }
    return expectedPageTitle === undefined
      ? pageDiscovered
      : titleMatches.size === 1 && titleMatches.has(pageId);
  }


  #unscopedWorkspaceRejection(
    authorization: ProviderWriteAuthorization | undefined,
    call: ModelToolCall,
    isWrite: boolean,
  ): string | undefined {
    if (!isWrite || authorization === undefined || authorization.workspace !== undefined) {
      return undefined;
    }
    const workspace = modelCallArguments(call)?.workspace;
    if (workspace === undefined) {
      return undefined;
    }
    if (typeof workspace !== "string") {
      return "The provider write exceeds the authorized account scope";
    }
    return this.#notionWriteWorkspaceMatches(authorization, workspace)
      ? undefined
      : "An unscoped provider write cannot select among multiple accounts";
  }

  #notionWriteWorkspaceMatches(
    authorization: ProviderWriteAuthorization,
    workspace: string,
  ): boolean {
    if (authorization.workspace !== undefined) {
      return workspace.trim() === authorization.workspace;
    }
    const capability = notionWriteCapability(authorization);
    const eligible = this.#connections
      .list()
      .filter(
        (connection) =>
          connection.provider === "notion" &&
          connection.status === "healthy" &&
          connection.capabilities.includes(capability),
      );
    return eligible.length === 1 && workspace.trim() === eligible[0]?.safeLabel;
  }

  #providerWriteCompletionRejection(
    runId: RunId,
    authorization: ProviderWriteAuthorization | undefined,
    userMessage: string,
    response: string,
  ): string | undefined {
    if (this.#hasSucceededProviderWrite(runId)) {
      return undefined;
    }
    if (
      authorization !== undefined &&
      this.#isValidatedConnectionClarification(runId, authorization, response)
    ) {
      return undefined;
    }
    const claimsWrite = claimsUnrequestedProviderWrite(userMessage, response);
    if (
      authorization !== undefined &&
      !claimsWrite &&
      this.#isValidatedNotionCheckboxNoOp(runId, authorization, response)
    ) {
      return undefined;
    }
    return authorization !== undefined || claimsWrite ? "unverified_write_claim" : undefined;
  }

  #isValidatedNotionCheckboxNoOp(
    runId: RunId,
    authorization: ProviderWriteAuthorization,
    response: string,
  ): boolean {
    if (
      authorization.kind !== "notion_task_checkbox" ||
      !responseExplicitlyDescribesCheckboxNoOp(response, authorization.checked)
    ) {
      return false;
    }
    const preparedWrite = this.#db
      .prepare<{ run_id: string }, { found: number }>(`
        SELECT 1 AS found FROM tool_executions
        WHERE run_id = @run_id AND operation_class = 'write'
        LIMIT 1
      `)
      .get({ run_id: runId });
    if (preparedWrite !== undefined) {
      return false;
    }
    const fetches = this.#db
      .prepare<
        { run_id: string },
        { arguments_json: string; result_json: string }
      >(`
        SELECT arguments_json, result_json
        FROM tool_executions
        WHERE run_id = @run_id
          AND tool_name = 'notion.fetch'
          AND status = 'succeeded'
          AND result_json IS NOT NULL
        ORDER BY created_at_ms DESC, id DESC
      `)
      .all({ run_id: runId });
    for (const fetch of fetches) {
      const fetchArguments = jsonRecord(fetch.arguments_json);
      const pageId = fetchArguments?.id;
      const fetchResult = jsonRecord(fetch.result_json);
      const workspace = asRecord(fetchResult?.workspace)?.label;
      const result = asRecord(fetchResult?.result);
      if (
        typeof pageId !== "string" ||
        typeof workspace !== "string" ||
        !this.#notionWriteWorkspaceMatches(authorization, workspace) ||
        result?.truncated !== false ||
        typeof result.text !== "string" ||
        !this.#notionPageWasDiscovered(runId, pageId, workspace, undefined)
      ) {
        continue;
      }
      if (checkboxNoOpIsProved(result.text, authorization, response)) {
        return true;
      }
    }
    return false;
  }

  #isValidatedConnectionClarification(
    runId: RunId,
    authorization: ProviderWriteAuthorization,
    response: string,
  ): boolean {
    if (authorization.workspace !== undefined) {
      return false;
    }
    const rows = this.#db
      .prepare<
        { run_id: string },
        {
          tool_name: string;
          status: string;
          result_json: string | null;
          write_intent_id: string | null;
        }
      >(`
        SELECT tools.tool_name, tools.status, tools.result_json,
               writes.id AS write_intent_id
        FROM tool_executions AS tools
        LEFT JOIN write_intents AS writes ON writes.tool_execution_id = tools.id
        WHERE tools.run_id = @run_id
          AND tools.operation_class = 'write'
        ORDER BY tools.created_at_ms, tools.id
        LIMIT 2
      `)
      .all({ run_id: runId });
    const row = rows[0];
    const expectedTool =
      authorization.kind === "notion_create_page"
        ? "notion.create_page"
        : "notion.update_page";
    const validExecutionState =
      rows.length === 0 ||
      (rows.length === 1 &&
        row !== undefined &&
        row.tool_name === expectedTool &&
        row.status === "failed" &&
        row.write_intent_id === null &&
        toolErrorCode(row.result_json) === "connection_ambiguous");
    if (!validExecutionState) {
      return false;
    }
    const lines = response
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const question = lines[1] ?? "";
    const questionEnd = question.indexOf("?");
    if (
      lines.length !== 2 ||
      lines[0] !== "🗂️ workspace:" ||
      questionEnd === -1 ||
      !/^› (?:which|what)\s+(?:notion\s+)?(?:workspace|account)\s+should\s+i\s+use(?::|—|-)\s+.+\?\s+repeat\s+the\s+full\s+request\s+ending\s+with\s+in\s+notion\s+workspace\s+<label>\.?$/iu.test(
        question,
      )
    ) {
      return false;
    }
    const capability = notionWriteCapability(authorization);
    const eligibleLabels = this.#connections
      .list()
      .filter(
        (connection) =>
          connection.provider === "notion" &&
          connection.status === "healthy" &&
          connection.capabilities.includes(capability),
      )
      .map((connection) => connection.safeLabel);
    const quotedLabels = jsonQuotedStrings(question.slice(0, questionEnd));
    return (
      eligibleLabels.length > 1 &&
      new Set(eligibleLabels).size === eligibleLabels.length &&
      quotedLabels !== undefined &&
      quotedLabels.length === eligibleLabels.length &&
      eligibleLabels.every(
        (label) => quotedLabels.filter((quoted) => quoted === label).length === 1,
      )
    );
  }

  #hasSucceededProviderWrite(runId: RunId): boolean {
    return (
      this.#db
        .prepare<{ run_id: string }, { found: number }>(`
          SELECT 1 AS found
          FROM tool_executions AS tools
          JOIN write_intents AS writes ON writes.tool_execution_id = tools.id
          WHERE tools.run_id = @run_id
            AND tools.operation_class = 'write'
            AND tools.status = 'succeeded'
            AND writes.state IN ('succeeded', 'reconciled_succeeded')
          LIMIT 1
        `)
        .get({ run_id: runId }) !== undefined
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

function providerWriteToolCallRejection(
  authorization: ProviderWriteAuthorization | undefined,
  call: ModelToolCall,
  isWrite: boolean,
): string | undefined {
  if (!isWrite) {
    return undefined;
  }
  if (authorization === undefined) {
    return "A provider write requires explicit authorization in the current raw user message";
  }
  let matches: boolean;
  switch (authorization.kind) {
    case "notion_create_page":
      matches = createPageCallMatches(authorization, call);
      break;
    case "notion_update_property":
      matches = updatePropertyCallMatches(authorization, call);
      break;
    case "notion_replace_content":
      matches = replaceContentCallMatches(authorization, call);
      break;
    case "notion_replace_text":
      matches = replaceTextCallMatches(authorization, call);
      break;
    case "notion_task_checkbox":
      matches = taskCheckboxCallMatches(authorization, call.name, modelCallArguments(call));
      break;
  }
  return matches ? undefined : "The provider write exceeds the authorized change";
}

function currentMessageProviderWriteAuthorization(
  message: string,
): ProviderWriteAuthorization | undefined {
  const scoped = scopedWriteRequest(directRequestBody(message));
  const authorization =
    createPageAuthorization(scoped.request) ??
    replaceContentAuthorization(scoped.request) ??
    replaceTextAuthorization(scoped.request) ??
    updatePropertyAuthorization(scoped.request) ??
    taskCheckboxAuthorization(scoped.request);
  return authorization === undefined || scoped.workspace === undefined
    ? authorization
    : { ...authorization, workspace: scoped.workspace };
}

function directRequestBody(message: string): string {
  return message
    .trim()
    .replaceAll("’", "'")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replace(/^(?:(?:hey|hi)\s+)?annie(?:[\s,:-]+|$)/iu, "")
    .trimStart()
    .replace(/^(?:please|pls)(?:[\s,:-]+|$)/iu, "")
    .trimStart()
    .replace(
      /^(?:(?:can|could|would|will)\s+you|(?:i'd|i would)\s+like\s+you\s+to|i\s+(?:want|need)\s+you\s+to)(?:[\s,:-]+|$)/iu,
      "",
    )
    .trimStart()
    .replace(/^(?:please|pls)(?:[\s,:-]+|$)/iu, "")
    .trimStart();
}

function scopedWriteRequest(
  request: string,
): { request: string; workspace?: string } {
  const match =
    /^(.*?)\s+in\s+(?:the\s+)?(?:notion\s+)?workspace\s+(?:(["'])(.+?)\2|(.+?))[.!?]*$/iu.exec(
      request,
    );
  if (match?.[1] === undefined) {
    return { request };
  }
  const workspace = (match[3] ?? match[4] ?? "").trim();
  return workspace.length === 0
    ? { request: "" }
    : { request: match[1].trimEnd(), workspace };
}

function createPageAuthorization(
  request: string,
): Extract<ProviderWriteAuthorization, { kind: "notion_create_page" }> | undefined {
  const requested =
    /^(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?(?:notion\s+)?page\s+(?:called|named|titled)\s+(.+)$/iu.exec(
      request,
    )?.[1];
  if (requested === undefined) {
    return undefined;
  }
  const contentMatch = /^(.+?)\s+with\s+(?:content|body)\s*:?\s*(.+)$/iu.exec(requested);
  const title = mutationValue(contentMatch?.[1] ?? requested);
  const content = contentMatch?.[2] === undefined ? undefined : mutationValue(contentMatch[2]);
  return title === undefined || (contentMatch !== null && content === undefined)
    ? undefined
    : {
        kind: "notion_create_page",
        title,
        ...(content === undefined ? {} : { content }),
      };
}

function replaceContentAuthorization(
  request: string,
): Extract<ProviderWriteAuthorization, { kind: "notion_replace_content" }> | undefined {
  const match =
    /^replace\s+(?:the\s+)?(?:content|body)\s+(?:of|in|on)\s+(?:the\s+)?(?:notion\s+)?(?:page|doc(?:ument)?)\s+(?:(["'])(.+?)\1|(.+?))\s+with\s+(.+)$/iu.exec(
      request,
    );
  const pageTitleValue = match?.[2] ?? match?.[3];
  const contentValue = match?.[4];
  if (pageTitleValue === undefined || contentValue === undefined) {
    return undefined;
  }
  const pageTitle = mutationValue(pageTitleValue);
  const content = mutationValue(contentValue);
  return pageTitle === undefined || content === undefined
    ? undefined
    : { kind: "notion_replace_content", pageTitle, content };
}

function replaceTextAuthorization(
  request: string,
): Extract<ProviderWriteAuthorization, { kind: "notion_replace_text" }> | undefined {
  const match =
    /^(?:replace|change)\s+(?:all(?:\s+occurrences?\s+of)?\s+)?(["'])(.+?)\1\s+(?:with|to)\s+(["'])(.*?)\3\s+(?:in|on)\s+(?:the\s+)?(?:notion\s+)?(?:page|doc(?:ument)?)\s+(.+?)[.!?]*$/iu.exec(
      request,
    );
  if (match?.[2] === undefined || match[4] === undefined || match[5] === undefined) {
    return undefined;
  }
  const pageTitle = mutationValue(match[5]);
  if (pageTitle === undefined) {
    return undefined;
  }
  return {
    kind: "notion_replace_text",
    oldText: match[2],
    newText: match[4],
    replaceAllMatches: /^(?:replace|change)\s+all(?:\s+occurrences?\s+of)?\s/iu.test(
      request,
    ),
    pageTitle,
  };
}

function updatePropertyAuthorization(
  request: string,
): Extract<ProviderWriteAuthorization, { kind: "notion_update_property" }> | undefined {
  const rename =
    /^rename\s+(?:the\s+)?(?:notion\s+)?(?:page|doc(?:ument)?)\s+(.+?)\s+to\s+(.+)$/iu.exec(
      request,
    );
  if (rename?.[1] !== undefined && rename[2] !== undefined) {
    const pageTitle = mutationValue(rename[1]);
    const value = mutationValue(rename[2]);
    return pageTitle === undefined || value === undefined
      ? undefined
      : { kind: "notion_update_property", property: "title", value, pageTitle };
  }
  const match =
    /^(?:set|change|update)\s+(?:the\s+)?(.+?)\s+(?:to|as)\s+(.+?)\s+(?:on|in)\s+(?:the\s+)?(?:notion\s+)?(?:page|doc(?:ument)?)\s+(.+?)[.!?]*$/iu.exec(
      request,
    );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  const property = mutationValue(match[1]);
  const value = mutationValue(match[2]);
  const pageTitle = mutationValue(match[3]);
  if (
    property === undefined ||
    value === undefined ||
    pageTitle === undefined ||
    (property.match(/[a-z0-9]+/giu)?.length ?? 0) > 4
  ) {
    return undefined;
  }
  return {
    kind: "notion_update_property",
    property: normalizeIdentifier(property),
    value,
    pageTitle,
  };
}

function createPageCallMatches(
  authorization: Extract<ProviderWriteAuthorization, { kind: "notion_create_page" }>,
  call: ModelToolCall,
): boolean {
  const args = call.name === "notion.create_page" ? modelCallArguments(call) : undefined;
  const properties = asRecord(args?.properties);
  if (
    args === undefined ||
    properties === undefined ||
    !hasOnlyKeys(args, ["workspace", "parent", "properties", "content"])
  ) {
    return false;
  }
  const entries = Object.entries(properties);
  const title = entries[0];
  return (
    workspaceMatches(authorization, args) &&
    entries.length === 1 &&
    title !== undefined &&
    ["name", "title"].includes(normalizeIdentifier(title[0])) &&
    typeof title[1] === "string" &&
    normalizeMutationText(title[1]) === authorization.title &&
    (authorization.content === undefined
      ? args.content === undefined
      : typeof args.content === "string" &&
        normalizeMutationText(args.content) === authorization.content)
  );
}

function updatePropertyCallMatches(
  authorization: Extract<ProviderWriteAuthorization, { kind: "notion_update_property" }>,
  call: ModelToolCall,
): boolean {
  const args = call.name === "notion.update_page" ? modelCallArguments(call) : undefined;
  const properties = asRecord(args?.properties);
  if (
    args?.command !== "update_properties" ||
    properties === undefined ||
    !hasOnlyKeys(args, ["workspace", "pageId", "command", "properties"])
  ) {
    return false;
  }
  const entries = Object.entries(properties);
  const property = entries[0];
  if (entries.length !== 1 || property === undefined) {
    return false;
  }
  const propertyName = normalizeIdentifier(property[0]);
  const propertyValue = scalarText(property[1]);
  return (
    propertyValue !== undefined &&
    workspaceMatches(authorization, args) &&
    (propertyName === authorization.property ||
      (authorization.property === "title" && propertyName === "name")) &&
    normalizeMutationText(propertyValue) === authorization.value
  );
}

function replaceContentCallMatches(
  authorization: Extract<ProviderWriteAuthorization, { kind: "notion_replace_content" }>,
  call: ModelToolCall,
): boolean {
  const args = call.name === "notion.update_page" ? modelCallArguments(call) : undefined;
  return (
    args?.command === "replace_content" &&
    workspaceMatches(authorization, args) &&
    hasOnlyKeys(args, ["workspace", "pageId", "command", "newContent"]) &&
    typeof args.newContent === "string" &&
    normalizeMutationText(args.newContent) === authorization.content
  );
}

function replaceTextCallMatches(
  authorization: Extract<ProviderWriteAuthorization, { kind: "notion_replace_text" }>,
  call: ModelToolCall,
): boolean {
  const args = call.name === "notion.update_page" ? modelCallArguments(call) : undefined;
  if (
    args?.command !== "update_content" ||
    !workspaceMatches(authorization, args) ||
    !hasOnlyKeys(args, ["workspace", "pageId", "command", "updates"]) ||
    !Array.isArray(args.updates) ||
    args.updates.length !== 1
  ) {
    return false;
  }
  const update = asRecord(args.updates[0]);
  if (
    update === undefined ||
    !hasOnlyKeys(update, ["oldText", "newText", "replaceAllMatches"]) ||
    typeof update.oldText !== "string" ||
    typeof update.newText !== "string" ||
    (update.replaceAllMatches ?? false) !== authorization.replaceAllMatches
  ) {
    return false;
  }
  if (authorization.replaceAllMatches) {
    return (
      update.oldText === authorization.oldText &&
      update.newText === authorization.newText
    );
  }
  const oldIndex = update.oldText.indexOf(authorization.oldText);
  if (
    oldIndex === -1 ||
    update.oldText.indexOf(
      authorization.oldText,
      oldIndex + authorization.oldText.length,
    ) !== -1
  ) {
    return false;
  }
  return (
    update.newText ===
    update.oldText.slice(0, oldIndex) +
      authorization.newText +
      update.oldText.slice(oldIndex + authorization.oldText.length)
  );
}

function modelCallArguments(call: ModelToolCall): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(call.argumentsJson));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function jsonQuotedStrings(value: string): readonly string[] | undefined {
  const literals = value.match(/"(?:\\.|[^"\\])*"/gu) ?? [];
  try {
    const parsed = literals.map((literal) => JSON.parse(literal) as unknown);
    return parsed.every((candidate): candidate is string => typeof candidate === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function toolErrorCode(resultJson: string | null): string | undefined {
  if (resultJson === null) {
    return undefined;
  }
  try {
    const error = asRecord(asRecord(JSON.parse(resultJson))?.error);
    return typeof error?.code === "string" ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function mutationValue(value: string): string | undefined {
  let normalized = value.trim();
  const quote = normalized[0];
  if (
    normalized.length >= 2 &&
    (quote === '"' || quote === "'") &&
    normalized.at(-1) === quote
  ) {
    normalized = normalized.slice(1, -1).trim();
  } else {
    normalized = normalized.replace(/[.!?]+$/u, "").trimEnd();
  }
  normalized = normalizeMutationText(normalized);
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeMutationText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function notionWriteCapability(
  authorization: ProviderWriteAuthorization,
): "notion.create_page" | "notion.update_page" {
  return authorization.kind === "notion_create_page"
    ? "notion.create_page"
    : "notion.update_page";
}

function workspaceMatches(
  authorization: ProviderWriteScope,
  argumentsValue: Record<string, unknown>,
): boolean {
  return (
    authorization.workspace === undefined ||
    (typeof argumentsValue.workspace === "string" &&
      argumentsValue.workspace.trim() === authorization.workspace)
  );
}

function normalizeIdentifier(value: string): string {
  return normalizeMutationText(value).toLowerCase();
}

function scalarText(value: unknown): string | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? String(value)
    : undefined;
}

function taskCheckboxAuthorization(
  request: string,
): Extract<ProviderWriteAuthorization, { kind: "notion_task_checkbox" }> | undefined {
  const checkedTarget =
    /^(?:mark|make|set)\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)[.!?]*$/iu.exec(
      request,
    )?.[1] ??
    /^(?:check|tick)\s+off\s+(.+?)[.!?]*$/iu.exec(request)?.[1] ??
    /^(?:check|tick)\s+(.+?)\s+off[.!?]*$/iu.exec(request)?.[1];
  if (checkedTarget !== undefined) {
    return taskCheckboxAuthorizationFor(checkedTarget, true);
  }
  const uncheckedTarget =
    /^(?:mark|make|set)\s+(.+?)\s+(?:as\s+)?(?:not done|incomplete|unchecked)[.!?]*$/iu.exec(
      request,
    )?.[1] ?? /^uncheck\s+(.+?)[.!?]*$/iu.exec(request)?.[1];
  return uncheckedTarget === undefined
    ? undefined
    : taskCheckboxAuthorizationFor(uncheckedTarget, false);
}

function taskCheckboxAuthorizationFor(
  target: string,
  checked: boolean,
): Extract<ProviderWriteAuthorization, { kind: "notion_task_checkbox" }> | undefined {
  const targetTokens = taskTokens(target);
  return targetTokens.length === 0
    ? undefined
    : { kind: "notion_task_checkbox", checked, targetTokens };
}

function taskCheckboxCallMatches(
  authorization: Extract<ProviderWriteAuthorization, { kind: "notion_task_checkbox" }>,
  toolName: string,
  argumentsValue: Record<string, unknown> | undefined,
): boolean {
  if (
    toolName !== "notion.update_page" ||
    argumentsValue?.command !== "update_content" ||
    !workspaceMatches(authorization, argumentsValue) ||
    !hasOnlyKeys(argumentsValue, ["workspace", "pageId", "command", "updates"])
  ) {
    return false;
  }
  const updates = argumentsValue.updates;
  if (!Array.isArray(updates) || updates.length !== 1) {
    return false;
  }
  const update = asRecord(updates[0]);
  if (
    update === undefined ||
    !hasOnlyKeys(update, ["oldText", "newText", "replaceAllMatches"]) ||
    typeof update.oldText !== "string" ||
    typeof update.newText !== "string" ||
    update.replaceAllMatches === true
  ) {
    return false;
  }
  const changedLine = singleChangedCheckboxLine(
    update.oldText,
    update.newText,
    authorization.checked,
  );
  return (
    changedLine !== undefined &&
    taskLabelMatches(authorization.targetTokens, changedLine)
  );
}

function taskLabelMatches(targetTokens: readonly string[], text: string): boolean {
  return taskLabelTokenMatches(targetTokens, taskLabelTokens(text));
}

function taskLabelTokenMatches(
  targetTokens: readonly string[],
  labelTokens: readonly string[],
): boolean {
  if (sameTokens(targetTokens, labelTokens)) {
    return true;
  }
  const targetHasAction =
    taskLabelActionVerbs.has(targetTokens[0] ?? "") ||
    (targetTokens[0] === "work" && targetTokens[1] === "on");
  if (targetHasAction) {
    return false;
  }
  const shorthandLabel =
    labelTokens[0] === "work" && labelTokens[1] === "on"
      ? labelTokens.slice(2)
      : taskLabelActionVerbs.has(labelTokens[0] ?? "")
        ? labelTokens.slice(1)
        : labelTokens;
  return (
    sameTokens(targetTokens, shorthandLabel) ||
    (targetTokens.length >= 2 &&
      shorthandLabel.length === targetTokens.length + 1 &&
      sameTokens(targetTokens, shorthandLabel.slice(1)))
  );
}

function singleChangedCheckboxLine(
  oldText: string,
  newText: string,
  checked: boolean,
): string | undefined {
  const oldMarkers = [...oldText.matchAll(checkboxMarkerPattern)];
  const newMarkers = [...newText.matchAll(checkboxMarkerPattern)];
  if (
    oldMarkers.length === 0 ||
    oldMarkers.length !== newMarkers.length ||
    oldText.replace(checkboxMarkerPattern, "[?]") !==
      newText.replace(checkboxMarkerPattern, "[?]")
  ) {
    return undefined;
  }
  let changedOffset: number | undefined;
  for (let index = 0; index < oldMarkers.length; index += 1) {
    const oldMarker = oldMarkers[index];
    const newMarker = newMarkers[index];
    if (
      oldMarker === undefined ||
      newMarker === undefined ||
      oldMarker.index !== newMarker.index
    ) {
      return undefined;
    }
    if (oldMarker[0] === newMarker[0]) {
      continue;
    }
    if (
      changedOffset !== undefined ||
      (checked
        ? oldMarker[0] !== "[ ]" || newMarker[0].toLowerCase() !== "[x]"
        : oldMarker[0].toLowerCase() !== "[x]" || newMarker[0] !== "[ ]")
    ) {
      return undefined;
    }
    changedOffset = oldMarker.index;
  }
  if (changedOffset === undefined) {
    return undefined;
  }
  const lineStart = oldText.lastIndexOf("\n", changedOffset - 1) + 1;
  const followingBreak = oldText.indexOf("\n", changedOffset);
  const lineEnd = followingBreak === -1 ? oldText.length : followingBreak;
  return oldText.slice(lineStart, lineEnd);
}

function matchingTaskCheckboxLabelCount(
  text: string,
  targetTokens: readonly string[],
): number {
  const labels = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    if (/\[(?: |x|X)\]/u.test(line) && taskLabelMatches(targetTokens, line)) {
      labels.add(taskLabelTokens(line).join("\u0000"));
    }
  }
  return labels.size;
}

function taskLabelTokens(text: string): readonly string[] {
  const checkboxLine = text
    .split(/\r?\n/u)
    .find((line) => /\[(?: |x|X)\]/u.test(line));
  const marker =
    checkboxLine === undefined ? null : /\[(?: |x|X)\]/u.exec(checkboxLine);
  return marker === null || checkboxLine === undefined
    ? []
    : taskTokens(checkboxLine.slice(marker.index + marker[0].length));
}

function taskTokens(value: string): readonly string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter(
    (token) => !taskTargetStopWords.has(token),
  );
}

function responseExplicitlyDescribesCheckboxNoOp(response: string, checked: boolean): boolean {
  const normalized = response.toLowerCase().replaceAll("’", "'");
  const alreadySet = checked
    ? /\balready\s+(?:marked\s+)?(?:done|complete|completed|checked(?:\s+off)?)\b/u.test(
        normalized,
      )
    : /\balready\s+(?:marked\s+)?(?:not\s+done|incomplete|unchecked)\b/u.test(normalized);
  const noChange =
    /\bno\s+change\s+(?:was\s+)?(?:made|needed)\b/u.test(normalized) ||
    /\bnothing\s+(?:was\s+)?changed\b/u.test(normalized);
  const firstPersonCheckboxWrite =
    /\b(?:i|we)(?:'ve| have| just)?\s+checked\s+(?:it|that|the\s+(?:task|box|checkbox|item))(?:\s+off)?\b/u.test(
      normalized,
    );
  return alreadySet && noChange && !firstPersonCheckboxWrite;
}

function checkboxNoOpIsProved(
  text: string,
  authorization: Extract<ProviderWriteAuthorization, { kind: "notion_task_checkbox" }>,
  response: string,
): boolean {
  const authorizedStates = taskCheckboxStates(text, (labelTokens) =>
    sameTokens(authorization.targetTokens, labelTokens),
  );
  if (authorizedStates.length === 1 && authorizedStates[0] === authorization.checked) {
    return true;
  }
  const selectedTokens = quotedAlreadySetTaskTokens(response, authorization.checked);
  if (
    selectedTokens === undefined ||
    !tokensAppearInOrder(authorization.targetTokens, selectedTokens)
  ) {
    return false;
  }
  const selectedStates = taskCheckboxStates(text, (labelTokens) =>
    sameTokens(selectedTokens, labelTokens),
  );
  if (selectedStates.length !== 1 || selectedStates[0] !== authorization.checked) {
    return false;
  }
  return responseAsksTaskClarification(response, selectedTokens);
}

function quotedAlreadySetTaskTokens(
  response: string,
  checked: boolean,
): readonly string[] | undefined {
  const selected = (
    checked
      ? /["“]([^"”\r\n]{1,200})["”]\s+(?:is|was)\s+already\s+(?:marked\s+)?(?:done|complete|completed|checked(?:\s+off)?)\b/iu
      : /["“]([^"”\r\n]{1,200})["”]\s+(?:is|was)\s+already\s+(?:marked\s+)?(?:not\s+done|incomplete|unchecked)\b/iu
  ).exec(response)?.[1];
  if (selected === undefined) {
    return undefined;
  }
  const tokens = taskTokens(selected);
  return tokens.length === 0 ? undefined : tokens;
}

function responseAsksTaskClarification(
  response: string,
  selectedTokens: readonly string[],
): boolean {
  const normalized = response.toLowerCase().replaceAll("’", "'");
  const cuePattern = /\b(?:did you mean|which|want me|were you)\b/gu;
  for (const cue of normalized.matchAll(cuePattern)) {
    const cueIndex = cue.index;
    const questionEnd = normalized.indexOf("?", cueIndex);
    if (questionEnd === -1) {
      continue;
    }
    const question = normalized.slice(cueIndex, questionEnd);
    const namesSelectedTask = tokensAppearInOrder(selectedTokens, taskTokens(question));
    const namesTaskKind = /\b(?:item|task|checkbox)\b/u.test(question);
    const hasBareTaskReference = /\b(?:that|this|it|one|those|them)\b/u.test(question);
    const hasTaskStateAction =
      /\b(?:mark(?:ed|ing)?|check(?:ed|ing)?|done|complete(?:d)?)\b/u.test(question);
    if (
      namesSelectedTask ||
      namesTaskKind ||
      (hasBareTaskReference && hasTaskStateAction)
    ) {
      return true;
    }
  }
  return false;
}

function taskCheckboxStates(
  text: string,
  matches: (labelTokens: readonly string[]) => boolean,
): readonly boolean[] {
  const states: boolean[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const marker = /\[([ xX])\]/u.exec(line);
    const state = marker?.[1];
    if (marker === null || state === undefined) {
      continue;
    }
    const labelTokens = taskLabelTokens(line);
    if (matches(labelTokens)) {
      states.push(state.toLowerCase() === "x");
    }
  }
  return states;
}

function tokensAppearInOrder(
  targetTokens: readonly string[],
  labelTokens: readonly string[],
): boolean {
  let targetIndex = 0;
  for (const token of labelTokens) {
    if (token === targetTokens[targetIndex]) {
      targetIndex += 1;
    }
  }
  return targetTokens.length > 0 && targetIndex === targetTokens.length;
}


function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function exactOccurrenceCount(text: string, target: string): number {
  if (target.length === 0) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

function claimsUnrequestedProviderWrite(userMessage: string, response: string): boolean {
  const normalized = response.trim().toLowerCase().replaceAll("’", "'");
  if (
    agentWriteSuccessClaimPattern.test(normalized) ||
    agentDidWriteSuccessClaimPattern.test(normalized)
  ) {
    return true;
  }
  const normalizedRequest = directRequestBody(userMessage).toLowerCase();
  return (
    directProviderWriteRequestPattern.test(normalizedRequest) &&
    (passiveWriteSuccessClaimPattern.test(normalized) ||
      providerStateSuccessClaimPattern.test(normalized))
  );
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
