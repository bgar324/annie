import { canonicalJson } from "../core/json.js";
import { ModelSafeError } from "../core/errors.js";
import type { RunId, TraceId } from "../core/ids.js";
import { maximumMessageTextCharacters } from "../messages/types.js";
import type { ChatModel, ModelMessage, ModelToolCall } from "./model.js";
import {
  AgentLimitError,
  AgentRunStore,
  type AgentRunRecord,
  type AgentRunSource,
} from "./store.js";
import { ToolRegistry, ToolRegistryError } from "./tools.js";
import type { WriteStore } from "../writes/store.js";

const maximumToolCallsPerResponse = 4;

export interface AgentLoopLimits {
  maxToolRounds: number;
  maxToolCalls: number;
  maxProviderWrites: number;
  maxRunMs: number;
}

export interface AgentLoopResult {
  run: AgentRunRecord;
  response: string;
  outcome: "completed" | "bounded";
}

export class AgentLoop {
  readonly #model: ChatModel;
  readonly #tools: ToolRegistry;
  readonly #runs: AgentRunStore;
  readonly #writes: WriteStore;
  readonly #limits: AgentLoopLimits;

  constructor(input: {
    model: ChatModel;
    tools: ToolRegistry;
    runs: AgentRunStore;
    writes: WriteStore;
    limits: AgentLoopLimits;
  }) {
    this.#model = input.model;
    this.#tools = input.tools;
    this.#runs = input.runs;
    this.#writes = input.writes;
    this.#limits = input.limits;
  }

  async execute(input: {
    source: AgentRunSource;
    traceId: TraceId;
    initialMessages: readonly ModelMessage[];
    allowedToolNames?: readonly string[];
    completionGuard?: (
      candidate: { runId: RunId; response: string },
    ) => string | undefined;
    jobLease?: { jobId: string; leaseToken: string };
    replay?: boolean;
  }): Promise<AgentLoopResult> {
    const allToolDefinitions = this.#tools.definitions();
    const allowedToolNames =
      input.allowedToolNames === undefined ? undefined : new Set(input.allowedToolNames);
    if (
      allowedToolNames !== undefined &&
      (allowedToolNames.size !== input.allowedToolNames?.length ||
        [...allowedToolNames].some(
          (name) => !allToolDefinitions.some((definition) => definition.name === name),
        ))
    ) {
      throw new Error("Agent run tool allowlist contains an unknown or duplicate tool");
    }
    const toolDefinitions =
      allowedToolNames === undefined
        ? allToolDefinitions
        : allToolDefinitions.filter((definition) => allowedToolNames.has(definition.name));
    const run = this.#runs.startOrResume({
      source: input.source,
      traceId: input.traceId,
      deadlineAtMs: Date.now() + this.#limits.maxRunMs,
    });
    if (input.jobLease !== undefined) {
      this.#runs.bindJob(run.id, input.jobLease.jobId, input.jobLease.leaseToken);
    }
    this.#runs.appendInitialMessages(run.id, input.initialMessages);
    if (run.phase === "completed") {
      return { run, response: run.finalResponse ?? "", outcome: "completed" };
    }
    if (run.phase !== "running") {
      return this.#bounded(run, run.failureCode ?? "run_not_resumable");
    }

    const remainingRunMs = run.deadlineAtMs - Date.now();
    if (remainingRunMs <= 0) {
      return this.#bounded(run, "run_deadline");
    }
    const runSignal = AbortSignal.timeout(remainingRunMs);

    try {
      for (;;) {
        this.#assertWithinDeadline(run, runSignal);
        const messages = this.#runs.loadMessages(run.id);
        const pending = pendingToolCalls(messages);
        if (pending.length > 0) {
          await this.#executeTools(
            run,
            messages,
            pending,
            input.replay ?? false,
            input.jobLease,
            allowedToolNames,
            runSignal,
          );
          continue;
        }
        const last = messages.at(-1);
        if (last?.role === "assistant" && (last.toolCalls?.length ?? 0) === 0) {
          const response = last.content.trim();
          if (response.length === 0) {
            return this.#bounded(run, "empty_model_response");
          }
          if (response.length > maximumMessageTextCharacters) {
            return this.#bounded(run, "response_too_large");
          }
          const rejection = input.completionGuard?.({ runId: run.id, response });
          if (rejection !== undefined) {
            return this.#bounded(run, rejection);
          }
          this.#runs.complete(run.id, response);
          return { run: this.#runs.getRequired(run.id), response, outcome: "completed" };
        }

        const toolRounds = messages.filter(
          (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
        ).length;
        if (toolRounds > this.#limits.maxToolRounds) {
          throw new AgentLimitError("round_limit", "The tool round limit was reached");
        }
        this.#runs.beginModelRequest(run.id, this.#limits.maxToolRounds + 1);
        let response;
        try {
          response = await this.#model.complete({
            traceId: run.traceId,
            runId: run.id,
            messages,
            tools: toolDefinitions,
            signal: runSignal,
          });
        } catch (error) {
          if (runSignal.aborted) {
            throw new AgentLimitError("run_deadline", "The agent run deadline was reached");
          }
          throw error;
        }
        this.#runs.appendAssistant(run.id, response);
        if (response.toolCalls.length > maximumToolCallsPerResponse) {
          throw new AgentLimitError(
            "tool_response_limit",
            "The model returned too many tool calls in one response",
          );
        }
        if (response.toolCalls.length > 0 && toolRounds >= this.#limits.maxToolRounds) {
          throw new AgentLimitError("round_limit", "The tool round limit was reached");
        }
      }
    } catch (error) {
      if (error instanceof AgentLimitError) {
        return this.#bounded(run, error.code);
      }
      if (error instanceof AmbiguousWriteResumeError) {
        return this.#bounded(run, "ambiguous_write");
      }
      throw error;
    }
  }

  async #executeTools(
    run: AgentRunRecord,
    messages: readonly ModelMessage[],
    calls: readonly ModelToolCall[],
    replay: boolean,
    jobLease: { jobId: string; leaseToken: string } | undefined,
    allowedToolNames: ReadonlySet<string> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const answered = answeredToolCalls(messages);
    for (const call of calls) {
      this.#assertWithinDeadline(run, signal);
      if (answered.has(call.id)) {
        continue;
      }
      if (allowedToolNames !== undefined && !allowedToolNames.has(call.name)) {
        throw new AgentLimitError(
          "tool_not_allowed",
          `Tool ${call.name} is not allowed for this agent run`,
        );
      }
      const operationClass = this.#tools.operationClass(call.name);
      const execution = this.#runs.prepareTool({
        runId: run.id,
        call,
        operationClass,
        maximumToolCalls: this.#limits.maxToolCalls,
      });
      if (
        execution.status === "succeeded" ||
        execution.status === "failed" ||
        execution.status === "ambiguous" ||
        execution.status === "not_executed"
      ) {
        this.#runs.appendToolMessage(run.id, call.id, boundedToolResult(execution.result));
        continue;
      }
      if (operationClass === "write" && execution.status === "running") {
        const write = this.#writes.getByToolExecution(execution.id);
        if (write !== undefined && write.state !== "prepared") {
          const acceptanceUnknown = {
            ok: false,
            error: {
              code: "acceptance_unknown",
              message: "The provider may have accepted this write; it was not repeated",
            },
          };
          if (write.state === "attempting") {
            this.#writes.complete({
              writeId: write.id,
              traceId: run.traceId,
              state: "ambiguous",
              normalizedResult: acceptanceUnknown,
            });
          }
          const recovered = this.#runs.getToolRequired(execution.id);
          this.#runs.appendToolMessage(
            run.id,
            call.id,
            boundedToolResult(recovered.result ?? acceptanceUnknown),
          );
          this.#runs.block(run.id, "ambiguous_write");
          throw new AmbiguousWriteResumeError();
        }
      }
      if (
        operationClass === "write" &&
        this.#runs.getRequired(run.id).providerWrites >= this.#limits.maxProviderWrites
      ) {
        const result = { ok: false, error: { code: "write_limit", message: "Provider write limit reached" } };
        this.#runs.finishTool(execution.id, "not_executed", result);
        this.#runs.appendToolMessage(run.id, call.id, canonicalJson(result));
        continue;
      }
      if (execution.status === "validated") {
        this.#runs.markToolRunning(execution.id);
      }
      try {
        const result = await this.#tools.execute({
          name: call.name,
          argumentsJson: call.argumentsJson,
          context: {
            runId: run.id,
            traceId: run.traceId,
            toolExecutionId: execution.id,
            connectionId: execution.connectionId,
            replay,
            ...(jobLease === undefined ? {} : { jobLease }),
            signal,
          },
        });
        const normalized = result === undefined ? null : result;
        const afterHandler = this.#runs.getToolRequired(execution.id);
        const finished =
          afterHandler.status === "validated" || afterHandler.status === "running"
            ? this.#runs.finishTool(execution.id, "succeeded", normalized)
            : afterHandler;
        this.#runs.appendToolMessage(
          run.id,
          call.id,
          boundedToolResult(finished.result ?? normalized),
        );
        if (finished.status === "ambiguous") {
          this.#runs.block(run.id, "ambiguous_write");
          throw new AmbiguousWriteResumeError();
        }
      } catch (error) {
        if (error instanceof AmbiguousWriteResumeError) {
          throw error;
        }
        let afterFailure = this.#runs.getToolRequired(execution.id);
        if (
          operationClass === "write" &&
          (afterFailure.status === "validated" || afterFailure.status === "running")
        ) {
          const write = this.#writes.getByToolExecution(execution.id);
          if (write?.state === "attempting") {
            const acceptanceUnknown = {
              ok: false,
              error: {
                code: "acceptance_unknown",
                message: "The provider may have accepted this write; it was not repeated",
              },
            };
            this.#writes.complete({
              writeId: write.id,
              traceId: run.traceId,
              state: "ambiguous",
              normalizedResult: acceptanceUnknown,
            });
            afterFailure = this.#runs.getToolRequired(execution.id);
          }
        }
        if (
          afterFailure.status === "succeeded" ||
          afterFailure.status === "failed" ||
          afterFailure.status === "ambiguous" ||
          afterFailure.status === "not_executed"
        ) {
          this.#runs.appendToolMessage(
            run.id,
            call.id,
            boundedToolResult(afterFailure.result),
          );
          if (afterFailure.status === "ambiguous") {
            this.#runs.block(run.id, "ambiguous_write");
            throw new AmbiguousWriteResumeError();
          }
          continue;
        }
        if (signal.aborted) {
          const deadlineResult = {
            ok: false,
            error: { code: "run_deadline", message: "The agent run deadline was reached" },
          };
          this.#runs.finishTool(execution.id, "failed", deadlineResult);
          throw new AgentLimitError("run_deadline", "The agent run deadline was reached");
        }
        const normalized = safeToolError(error);
        this.#runs.finishTool(execution.id, "failed", normalized);
        this.#runs.appendToolMessage(run.id, call.id, canonicalJson(normalized));
      }
    }
  }

  #bounded(run: AgentRunRecord, code: string): AgentLoopResult {
    const response = boundedResponse(code);
    const current = this.#runs.getRequired(run.id);
    if (current.phase === "running") {
      this.#runs.block(run.id, code);
    }
    return { run: this.#runs.getRequired(run.id), response, outcome: "bounded" };
  }

  #assertWithinDeadline(run: AgentRunRecord, signal: AbortSignal): void {
    if (signal.aborted || Date.now() >= run.deadlineAtMs) {
      throw new AgentLimitError("run_deadline", "The agent run deadline was reached");
    }
  }
}

class AmbiguousWriteResumeError extends Error {
  constructor() {
    super("A dispatched provider write has unknown acceptance");
    this.name = "AmbiguousWriteResumeError";
  }
}

function pendingToolCalls(messages: readonly ModelMessage[]): readonly ModelToolCall[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      const answered = new Set(
        messages
          .slice(index + 1)
          .filter((candidate): candidate is Extract<ModelMessage, { role: "tool" }> => candidate.role === "tool")
          .map((candidate) => candidate.toolCallId),
      );
      return message.toolCalls?.filter((call) => !answered.has(call.id)) ?? [];
    }
  }
  return [];
}

function answeredToolCalls(messages: readonly ModelMessage[]): ReadonlySet<string> {
  return new Set(
    messages
      .filter((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool")
      .map((message) => message.toolCallId),
  );
}

function boundedToolResult(result: unknown): string {
  const serialized = canonicalJson(result);
  if (Buffer.byteLength(serialized) <= 131_072) {
    return serialized;
  }
  return canonicalJson({
    ok: false,
    error: {
      code: "tool_result_too_large",
      message: "The tool result exceeded the 128 KiB transcript limit",
    },
  });
}

function safeToolError(error: unknown): {
  ok: false;
  error: { code: string; message: string };
} {
  if (error instanceof ToolRegistryError || error instanceof ModelSafeError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return {
    ok: false,
    error: {
      code: "tool_failed",
      message: "The tool failed at its provider boundary",
    },
  };
}

function boundedResponse(code: string): string {
  if (code === "ambiguous_write") {
    return "I stopped because the provider may have accepted a write. I did not repeat it.";
  }
  return "I stopped before completing that request because the safe execution limit was reached.";
}
