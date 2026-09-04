import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import { canonicalJson } from "../core/json.js";
import { createTracedProviderFetch, type ProviderFetch } from "../providers/fetch.js";
import type { TraceStore } from "../tracing/store.js";
import {
  ModelProviderError,
  type ChatModel,
  type MemoryMaintenanceModel,
  type MemoryMaintenanceRequest,
  type MemoryMaintenanceResponse,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
} from "./model.js";

const maximumRequestAttempts = 8;
const retryBaseDelayMs = 1_000;
const maximumRetryDelayMs = 30_000;

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1),
      arguments: z.string().default("{}"),
    }),
  })
  .passthrough();

const providerMessageSchema = z
  .object({
    role: z.literal("assistant").optional(),
    content: z.string().nullish(),
    tool_calls: z.array(toolCallSchema).nullish(),
  })
  .passthrough();

const responseSchema = z.object({
  id: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: providerMessageSchema,
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class DeepSeekChatModel implements ChatModel, MemoryMaintenanceModel {
  readonly #config: RuntimeConfig;
  readonly #traces: TraceStore;
  readonly #fetchImpl: ProviderFetch | undefined;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    config: RuntimeConfig;
    traces: TraceStore;
    fetchImpl?: ProviderFetch;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#config = input.config;
    this.#traces = input.traces;
    this.#fetchImpl = input.fetchImpl;
    this.#sleep = input.sleep ?? delay;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const wireToolNames = new Map(
      request.tools.map((tool) => [toDeepSeekToolName(tool.name), tool.name] as const),
    );
    if (wireToolNames.size !== request.tools.length) {
      throw new Error("Tool names collide after DeepSeek wire-name conversion");
    }
    return this.#request({
      traceId: request.traceId,
      runId: request.runId,
      fetchComponent: "deepseek",
      traceComponent: "model",
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      wireToolNames,
      body: {
        model: this.#config.deepseek.model,
        messages: request.messages.map(toDeepSeekMessage),
        reasoning_effort: request.reasoningEffort ?? this.#config.deepseek.reasoningEffort,
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
        ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: toDeepSeekToolName(tool.name),
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }),
      },
    });
  }

  async maintainMemory(request: MemoryMaintenanceRequest): Promise<MemoryMaintenanceResponse> {
    const response = await this.#request({
      traceId: request.traceId,
      runId: request.runId,
      fetchComponent: "deepseek_memory",
      traceComponent: "memory_model",
      signal: request.signal,
      wireToolNames: new Map(),
      body: {
        model: this.#config.deepseek.model,
        messages: request.messages,
        reasoning_effort: this.#config.deepseek.reasoningEffort,
      },
    });
    if (response.toolCalls.length > 0) {
      throw new ModelProviderError({
        kind: "terminal",
        message: "DeepSeek returned tool calls during memory maintenance",
      });
    }
    return { id: response.id, content: response.content, usage: response.usage };
  }

  async #request(input: {
    traceId: ModelRequest["traceId"];
    runId: ModelRequest["runId"];
    fetchComponent: string;
    traceComponent: string;
    wireToolNames: ReadonlyMap<string, string>;
    body: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ModelResponse> {
    const providerFetch = createTracedProviderFetch({
      traces: this.#traces,
      traceId: input.traceId,
      component: input.fetchComponent,
      timeoutMs: this.#config.deepseek.requestTimeoutMs,
      ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
    });
    const url = `${this.#config.deepseek.baseUrl}/chat/completions`;

    for (let attempt = 1; attempt <= maximumRequestAttempts; attempt += 1) {
      input.signal?.throwIfAborted();
      let response: Response;
      try {
        input.signal?.throwIfAborted();
        response = await providerFetch(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#config.deepseek.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input.body),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        if (input.signal?.aborted === true) {
          throw error;
        }
        if (attempt < maximumRequestAttempts) {
          await waitForRetry(this.#sleep, retryBackoff(attempt), input.signal);
          continue;
        }
        throw new ModelProviderError({
          kind: "transient",
          message: `DeepSeek could not be reached after ${maximumRequestAttempts} attempts`,
          cause: error,
        });
      }

      const text = await response.text();
      if (Buffer.byteLength(text) > 4_194_304) {
        throw new ModelProviderError({
          kind: "terminal",
          message: "DeepSeek returned a response larger than 4 MiB",
          status: response.status,
          ...providerRequestMetadata(response),
        });
      }
      if (!response.ok) {
        const retryable = [429, 500, 502, 503, 504].includes(response.status);
        if (retryable && attempt < maximumRequestAttempts) {
          await waitForRetry(this.#sleep, retryDelay(response.headers, attempt), input.signal);
          continue;
        }
        throw new ModelProviderError({
          kind: response.status === 429 ? "rate_limited" : retryable ? "transient" : "terminal",
          message: `DeepSeek returned HTTP ${response.status}`,
          status: response.status,
          ...providerRequestMetadata(response),
        });
      }

      let parsed: z.infer<typeof responseSchema>;
      try {
        parsed = responseSchema.parse(JSON.parse(text));
      } catch (error) {
        throw new ModelProviderError({
          kind: "terminal",
          message: "DeepSeek returned an invalid chat completion",
          status: response.status,
          ...providerRequestMetadata(response),
          cause: error,
        });
      }
      const choice = parsed.choices[0]!;
      const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: input.wireToolNames.get(call.function.name) ?? call.function.name,
        argumentsJson:
          call.function.arguments.trim() === "" ? "{}" : call.function.arguments,
      }));
      if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
        throw new ModelProviderError({
          kind: "terminal",
          message: "DeepSeek returned duplicate tool call IDs",
        });
      }
      const providerMessage = { role: "assistant" as const, ...choice.message };
      const result: ModelResponse = {
        id: parsed.id ?? null,
        content: choice.message.content ?? "",
        providerState: canonicalJson(providerMessage),
        toolCalls,
        finishReason: choice.finish_reason ?? null,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? null,
          completionTokens: parsed.usage?.completion_tokens ?? null,
          totalTokens: parsed.usage?.total_tokens ?? null,
        },
      };
      this.#traces.append({
        traceId: input.traceId,
        component: input.traceComponent,
        event: "response_received",
        outcome: result.finishReason ?? "unknown",
        runId: input.runId,
        ...providerRequestMetadata(response),
        data: {
          responseId: result.id,
          toolCallCount: result.toolCalls.length,
          contentBytes: Buffer.byteLength(result.content),
          providerStateBytes: Buffer.byteLength(result.providerState ?? ""),
          usage: result.usage,
        },
      });
      return result;
    }
    throw new Error("Unreachable DeepSeek retry state");
  }
}

function toDeepSeekMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    if (message.providerState !== undefined) {
      try {
        const providerMessage = providerMessageSchema.parse(JSON.parse(message.providerState));
        return { role: "assistant", ...providerMessage };
      } catch (error) {
        throw new ModelProviderError({
          kind: "terminal",
          message: "Stored DeepSeek assistant state is invalid",
          cause: error,
        });
      }
    }
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: toDeepSeekToolName(call.name), arguments: call.argumentsJson },
            })),
          }),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  return { role: message.role, content: message.content };
}

function toDeepSeekToolName(name: string): string {
  return name.replaceAll(".", "_");
}

function providerRequestMetadata(response: Response): { providerRequestId?: string } {
  const providerRequestId = response.headers.get("x-request-id");
  return providerRequestId === null ? {} : { providerRequestId };
}

function retryDelay(headers: Headers, attempt: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maximumRetryDelayMs, seconds * 1_000);
    }
  }
  return retryBackoff(attempt);
}

function retryBackoff(attempt: number): number {
  return Math.min(maximumRetryDelayMs, retryBaseDelayMs * 2 ** (attempt - 1));
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function waitForRetry(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await sleep(milliseconds);
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      reject(error);
    };
    const onAbort = () => fail(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => sleep(milliseconds))
      .then(succeed, fail);
    if (signal.aborted) {
      onAbort();
    }
  });
}
