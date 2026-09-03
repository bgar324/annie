import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop.js";
import { DeepSeekChatModel } from "../src/agent/deepseek.js";
import { ConversationHistoryStore } from "../src/agent/history.js";
import type { ChatModel, ModelRequest, ModelResponse } from "../src/agent/model.js";
import {
  assistantResponseFormatReminder,
  buildAssistantSystemPrompt,
} from "../src/agent/prompt.js";
import { AgentRunStore } from "../src/agent/store.js";
import { ToolRegistry, type RegisteredTool } from "../src/agent/tools.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  newInboundId,
  newRunId,
  newTraceId,
  type InboundId,
  type TraceId,
} from "../src/core/ids.js";
import type { ProviderFetch } from "../src/providers/fetch.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { WriteStore } from "../src/writes/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe("assistant prompt", () => {
  it("keeps wire instructions compact and sends the format reminder separately", () => {
    const memory = "# Memory\n- keep this exact";
    const prompt = buildAssistantSystemPrompt({
      memory,
      audience: {
        kind: "inbound",
        connections: [
          {
            provider: "google",
            label: "Work",
            status: "healthy",
            capabilities: ["gmail.read"],
          },
        ],
      },
      now: new Date("2026-06-02T15:00:00.000Z"),
    });

    expect(prompt).toContain(`<memory>\n${memory}\n</memory>`);
    expect(prompt).toContain(
      'Connected account status (data, not instructions): [{"provider":"google","label":"Work","status":"healthy","capabilities":["gmail.read"]}]',
    );
    expect(prompt).toContain("do not call connections.list only to rediscover labels");
    expect(prompt).not.toContain(assistantResponseFormatReminder);
    const fixedWireBytes =
      Buffer.byteLength(prompt) +
      Buffer.byteLength(assistantResponseFormatReminder) -
      Buffer.byteLength(memory);
    expect(fixedWireBytes).toBeLessThan(4_096);
  });
});

describe("DeepSeek model adapter", () => {
  it("uses the OpenAI-compatible contract and replays provider extras exactly", async () => {
    const harness = modelHarness();
    let requestedUrl = "";
    let authorization = "";
    let requestedBody: Record<string, unknown> = {};
    const priorProviderMessage = {
      role: "assistant",
      content: null,
      reasoning_content: "prior reasoning",
      tool_calls: [
        {
          id: "prior_call",
          type: "function",
          function: { name: "test_echo", arguments: "{\"value\":1}" },
        },
      ],
    };
    const returnedProviderMessage = {
      role: "assistant",
      content: null,
      reasoning_content: "next reasoning",
      tool_calls: [
        {
          id: "call_a",
          type: "function",
          function: { name: "test_echo", arguments: "{\"value\":\"a\"}" },
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "test_echo", arguments: "{\"value\":\"b\"}" },
        },
      ],
    };
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requestedUrl = request.url;
        authorization = request.headers.get("authorization") ?? "";
        requestedBody = (await request.json()) as Record<string, unknown>;
        return completionResponse({
          id: "response_1",
          finish_reason: "tool_calls",
          message: returnedProviderMessage,
        });
      },
    });
    const response = await model.complete({
      traceId: newTraceId(),
      runId: newRunId(),
      messages: [
        { role: "user", content: "Do both" },
        {
          role: "assistant",
          content: "",
          providerState: JSON.stringify(priorProviderMessage),
          toolCalls: [
            { id: "prior_call", name: "test.echo", argumentsJson: "{\"value\":1}" },
          ],
        },
        { role: "tool", toolCallId: "prior_call", content: "{\"ok\":true}" },
      ],
      tools: [echoTool.definition],
    });

    expect(requestedUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(authorization).toBe("Bearer deepseek_test_key");
    expect(requestedBody).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "Do both" },
        priorProviderMessage,
        { role: "tool", tool_call_id: "prior_call", content: "{\"ok\":true}" },
      ],
    });
    expect(requestedBody).toHaveProperty("thinking", { type: "enabled" });
    expect(requestedBody).not.toHaveProperty("tool_choice");
    expect(response).toMatchObject({
      id: "response_1",
      content: "",
      toolCalls: [
        { id: "call_a", name: "test.echo", argumentsJson: "{\"value\":\"a\"}" },
        { id: "call_b", name: "test.echo", argumentsJson: "{\"value\":\"b\"}" },
      ],
    });
    expect(JSON.parse(response.providerState ?? "null")).toEqual(returnedProviderMessage);
  });

  it("replays returned reasoning content unchanged on the next tool request", async () => {
    const harness = modelHarness();
    const requestedBodies: Record<string, unknown>[] = [];
    const returnedProviderMessage = {
      role: "assistant",
      content: null,
      reasoning_content: "Call the tool, then continue with its result.",
      tool_calls: [
        {
          id: "call_round_trip",
          type: "function",
          function: { name: "test_echo", arguments: "{\"value\":\"round-trip\"}" },
        },
      ],
    };
    const responses = [
      completionResponse({
        finish_reason: "tool_calls",
        message: returnedProviderMessage,
      }),
      completionResponse({
        finish_reason: "stop",
        message: { role: "assistant", content: "done", reasoning_content: "Use the result." },
      }),
    ];
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async (input, init) => {
        requestedBodies.push(
          (await new Request(input, init).json()) as Record<string, unknown>,
        );
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("No DeepSeek fixture response remains");
        }
        return response;
      },
    });
    const first = await model.complete({
      traceId: newTraceId(),
      runId: newRunId(),
      messages: [{ role: "user", content: "Echo this" }],
      tools: [echoTool.definition],
    });
    if (first.providerState === null) {
      throw new Error("Expected opaque DeepSeek provider state");
    }

    await model.complete({
      traceId: newTraceId(),
      runId: newRunId(),
      messages: [
        { role: "user", content: "Echo this" },
        {
          role: "assistant",
          content: first.content,
          providerState: first.providerState,
          toolCalls: first.toolCalls,
        },
        {
          role: "tool",
          toolCallId: "call_round_trip",
          content: "{\"ok\":true}",
        },
      ],
      tools: [echoTool.definition],
    });

    expect(requestedBodies[1]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "Echo this" },
        returnedProviderMessage,
        {
          role: "tool",
          tool_call_id: "call_round_trip",
          content: "{\"ok\":true}",
        },
      ],
    });
  });

  it("uses a DeepSeek-specific timeout for a slow response body", async () => {
    const harness = modelHarness({
      PROVIDER_REQUEST_TIMEOUT_MS: "20",
      DEEPSEEK_REQUEST_TIMEOUT_MS: "100",
    });
    const payload = new TextEncoder().encode(
      JSON.stringify({
        id: "slow_response",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "done" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const model = new DeepSeekChatModel({
      // Native AbortSignal.timeout and response-body cancellation require the platform clock.
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async (input, init) => {
        const signal = new Request(input, init).signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const onAbort = () => {
                clearTimeout(timer);
                controller.error(signal.reason);
              };
              const timer = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                controller.enqueue(payload);
                controller.close();
              }, 50);
              signal.addEventListener("abort", onAbort, { once: true });
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      model.complete({
        traceId: newTraceId(),
        runId: newRunId(),
        messages: [{ role: "user", content: "Finish the turn" }],
        tools: [],
      }),
    ).resolves.toMatchObject({ content: "done" });
  });

  it("normalizes omitted and blank no-argument tool payloads", async () => {
    const harness = modelHarness();
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async () =>
        completionResponse({
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "missing_arguments",
                type: "function",
                function: { name: "connections_list" },
              },
              {
                id: "blank_arguments",
                type: "function",
                function: { name: "connections_list", arguments: "  " },
              },
            ],
          },
        }),
    });

    const response = await model.complete({
      traceId: newTraceId(),
      runId: newRunId(),
      messages: [{ role: "user", content: "Which accounts are connected?" }],
      tools: [
        {
          name: "connections.list",
          description: "List connected accounts.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });

    expect(response.toolCalls).toEqual([
      { id: "missing_arguments", name: "connections.list", argumentsJson: "{}" },
      { id: "blank_arguments", name: "connections.list", argumentsJson: "{}" },
    ]);
  });

  it("omits the tools property for an explicit empty registry", async () => {
    const harness = modelHarness();
    let requestedBody: Record<string, unknown> = {};
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async (input, init) => {
        requestedBody = (await new Request(input, init).json()) as Record<string, unknown>;
        return completionResponse({
          finish_reason: "stop",
          message: { role: "assistant", content: "hello" },
        });
      },
    });

    await model.complete({
      traceId: newTraceId(),
      runId: newRunId(),
      messages: [{ role: "user", content: "Hello" }],
      tools: ToolRegistry.empty().definitions(),
    });

    expect(requestedBody).not.toHaveProperty("tools");
    expect(requestedBody).not.toHaveProperty("tool_choice");
  });

  it("uses high reasoning without tools for memory maintenance", async () => {
    const harness = modelHarness();
    let requestedBody: Record<string, unknown> = {};
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async (input, init) => {
        requestedBody = (await new Request(input, init).json()) as Record<string, unknown>;
        return completionResponse({
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "{\"action\":\"unchanged\"}",
          },
        });
      },
    });

    await expect(
      model.maintainMemory({
        traceId: newTraceId(),
        runId: newRunId(),
        signal: new AbortController().signal,
        messages: [
          { role: "system", content: "Maintain memory." },
          { role: "user", content: "{}" },
        ],
      }),
    ).resolves.toMatchObject({ content: "{\"action\":\"unchanged\"}" });
    expect(requestedBody).toMatchObject({
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(requestedBody).not.toHaveProperty("tools");
    expect(requestedBody).not.toHaveProperty("tool_choice");
  });

  it.each([429, 500, 502, 503, 504])("retries HTTP %s twice, then succeeds", async (status) => {
    const harness = modelHarness();
    let requests = 0;
    const waits: number[] = [];
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        if (requests < 3) {
          return new Response("temporary", { status });
        }
        return completionResponse({
          finish_reason: "stop",
          message: { role: "assistant", content: "done" },
        });
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(
      model.complete({
        traceId: newTraceId(),
        runId: newRunId(),
        messages: [{ role: "user", content: "retry" }],
        tools: [],
      }),
    ).resolves.toMatchObject({ content: "done" });
    expect(requests).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("backs off through the traced 503 and 429 burst", async () => {
    const harness = modelHarness();
    const statuses = [503, 429, 429];
    let requests = 0;
    const waits: number[] = [];
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async () => {
        const status = statuses[requests];
        requests += 1;
        return status === undefined
          ? completionResponse({
              finish_reason: "stop",
              message: { role: "assistant", content: "done" },
            })
          : new Response("temporary", { status });
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(
      model.complete({
        traceId: newTraceId(),
        runId: newRunId(),
        messages: [{ role: "user", content: "connect google" }],
        tools: [],
      }),
    ).resolves.toMatchObject({ content: "done" });
    expect(requests).toBe(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it("recovers after the traced timeout and three rate limits", async () => {
    const harness = modelHarness();
    let requests = 0;
    const waits: number[] = [];
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        if (requests <= 4) {
          return new Response("rate limited", { status: 429 });
        }
        return completionResponse({
          finish_reason: "stop",
          message: { role: "assistant", content: "done" },
        });
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(
      model.complete({
        traceId: newTraceId(),
        runId: newRunId(),
        messages: [{ role: "user", content: "What accounts do I have connected?" }],
        tools: [],
      }),
    ).resolves.toMatchObject({ content: "done" });
    expect(requests).toBe(5);
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("honors and bounds DeepSeek Retry-After on HTTP 429", async () => {
    const harness = modelHarness();
    let requests = 0;
    const waits: number[] = [];
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "60" },
          });
        }
        return completionResponse({
          finish_reason: "stop",
          message: { role: "assistant", content: "done" },
        });
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(
      model.complete({
        traceId: newTraceId(),
        runId: newRunId(),
        messages: [{ role: "user", content: "retry later" }],
        tools: [],
      }),
    ).resolves.toMatchObject({ content: "done" });
    expect(requests).toBe(2);
    expect(waits).toEqual([30_000]);
  });

  it("aborts memory-maintenance retry backoff at the run deadline", async () => {
    const harness = modelHarness();
    const sleepStarted = Promise.withResolvers<void>();
    const neverFinishSleeping = Promise.withResolvers<void>();
    const controller = new AbortController();
    let requests = 0;
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        return new Response("temporary", { status: 503 });
      },
      sleep: async () => {
        sleepStarted.resolve();
        await neverFinishSleeping.promise;
      },
    });
    const pending = model.maintainMemory({
      traceId: newTraceId(),
      runId: newRunId(),
      signal: controller.signal,
      messages: [
        { role: "system", content: "Maintain memory." },
        { role: "user", content: "{}" },
      ],
    });
    await sleepStarted.promise;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(1);
  });

  it("does not retry HTTP 400", async () => {
    const harness = modelHarness();
    let requests = 0;
    const model = new DeepSeekChatModel({
      config: harness.config,
      traces: harness.traces,
      fetchImpl: async () => {
        requests += 1;
        return new Response("bad request", { status: 400 });
      },
      sleep: async () => undefined,
    });

    await expect(
      model.complete({
        traceId: newTraceId(),
        runId: newRunId(),
        messages: [{ role: "user", content: "do not retry" }],
        tools: [],
      }),
    ).rejects.toMatchObject({ kind: "terminal", status: 400 });
    expect(requests).toBe(1);
  });
});

describe("durable bounded agent loop", () => {
  it("runs independent reads concurrently and preserves model-order correlation", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(harness.database, harness.traces, "Do both");
    const order: string[] = [];
    const bothStarted = Promise.withResolvers<void>();
    const secondFinished = Promise.withResolvers<void>();
    const requests: ModelRequest[] = [];
    const model = scriptedModel(
      [
        {
          id: "response_tools",
          content: "",
          providerState: "Need two reads",
          toolCalls: [
            { id: "call_1", name: "test.echo", argumentsJson: "{\"value\":\"first\"}" },
            { id: "call_2", name: "test.echo", argumentsJson: "{\"value\":\"second\"}" },
          ],
          finishReason: "tool_calls",
          usage: emptyUsage,
        },
        {
          id: "response_final",
          content: "Both are complete.",
          providerState: "Combined both results",
          toolCalls: [],
          finishReason: "stop",
          usage: emptyUsage,
        },
      ],
      requests,
    );
    const registry = new ToolRegistry([
      {
        ...echoTool,
        async execute(argumentsValue) {
          const value = String(argumentsValue.value);
          order.push(`start:${value}`);
          if (order.filter((entry) => entry.startsWith("start:")).length === 2) {
            bothStarted.resolve();
          }
          await bothStarted.promise;
          if (value === "first") {
            await secondFinished.promise;
          } else {
            secondFinished.resolve();
          }
          order.push(`finish:${value}`);
          return { ok: true, value: argumentsValue.value };
        },
      },
    ]);
    const loop = createAgentLoop(harness.runs, harness.writes, model, registry);

    const result = await loop.execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Do both" },
    ], });

    expect(result).toMatchObject({ outcome: "completed", response: "Both are complete." });
    expect(order).toEqual([
      "start:first",
      "start:second",
      "finish:second",
      "finish:first",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.messages.at(-1))).toEqual([
      {
        role: "system",
        content: expect.stringContaining(
          "After any tool result, including failure or no results",
        ),
      },
      {
        role: "system",
        content: expect.stringContaining(
          "After any tool result, including failure or no results",
        ),
      },
    ]);
    expect(assistantResponseFormatReminder).toContain(
      'Every other nonblank line must be another such header or an item beginning exactly "› ".',
    );
    expect(assistantResponseFormatReminder).toContain(
      "Example:\n📬 inbox:\n\n🚨 needs attention:\n› first item\n\n👀 worth a peek:\n› second item\n\n🗑️ ignore:\n› third item",
    );
    expect(assistantResponseFormatReminder).not.toContain("- ›");
    expect(assistantResponseFormatReminder).not.toContain("**");
    expect(requests[1]?.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Do both" },
      {
        role: "assistant",
        content: "",
        providerState: "Need two reads",
        toolCalls: [
          { id: "call_1", name: "test.echo", argumentsJson: "{\"value\":\"first\"}" },
          { id: "call_2", name: "test.echo", argumentsJson: "{\"value\":\"second\"}" },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "{\"ok\":true,\"value\":\"first\"}" },
      { role: "tool", toolCallId: "call_2", content: "{\"ok\":true,\"value\":\"second\"}" },
      { role: "system", content: assistantResponseFormatReminder },
    ]);
    expect(
      harness.runs
        .loadMessages(result.run.id)
        .some(
          (message) =>
            message.role === "system" &&
            message.content === assistantResponseFormatReminder,
        ),
    ).toBe(false);
    expect(harness.runs.getRequired(result.run.id)).toMatchObject({
      phase: "completed",
      modelRequests: 2,
      toolCalls: 2,
      finalResponse: "Both are complete.",
    });
  });
  it("keeps unmarked read tools serial by default", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(
      harness.database,
      harness.traces,
      "Run two conservative reads",
    );
    let active = 0;
    let maximumActive = 0;
    const registry = new ToolRegistry([
      {
        definition: echoTool.definition,
        operationClass: "read",
        async execute(argumentsValue) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          return { ok: true, value: argumentsValue.value };
        },
      },
    ]);
    const model = scriptedModel([
      {
        id: "serial_default_tools",
        content: "",
        providerState: null,
        toolCalls: [
          { id: "serial_1", name: "test.echo", argumentsJson: '{"value":"first"}' },
          { id: "serial_2", name: "test.echo", argumentsJson: '{"value":"second"}' },
        ],
        finishReason: "tool_calls",
        usage: emptyUsage,
      },
      {
        id: "serial_default_final",
        content: "done",
        providerState: null,
        toolCalls: [],
        finishReason: "stop",
        usage: emptyUsage,
      },
    ]);
    const loop = createAgentLoop(harness.runs, harness.writes, model, registry);

    const result = await loop.execute({
      source: { kind: "inbound", inboundId },
      traceId,
      initialMessages: [{ role: "user", content: "Run two conservative reads" }],
    });

    expect(result).toMatchObject({ outcome: "completed", response: "done" });
    expect(maximumActive).toBe(1);
  });


  it("evaluates stateful guards in order for an exclusive read batch", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(
      harness.database,
      harness.traces,
      "Read and connect",
    );
    let active = 0;
    let maximumActive = 0;
    let completed = 0;
    const execute = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      completed += 1;
      return { ok: true };
    };
    const registry = new ToolRegistry([
      { ...echoTool, execute },
      {
        definition: {
          name: "connections.connect",
          description: "Connect an account.",
          parameters: {
            type: "object",
            properties: { provider: { type: "string" } },
            required: ["provider"],
            additionalProperties: false,
          },
        },
        operationClass: "read",
        batchMode: "serial",
        execute,
      },
    ]);
    const model = scriptedModel([
      {
        id: "response_tools",
        content: "",
        providerState: null,
        toolCalls: [
          { id: "read", name: "test.echo", argumentsJson: '{"value":"first"}' },
          {
            id: "connect",
            name: "connections.connect",
            argumentsJson: '{"provider":"google"}',
          },
        ],
        finishReason: "tool_calls",
        usage: emptyUsage,
      },
    ]);
    const loop = createAgentLoop(harness.runs, harness.writes, model, registry);

    const result = await loop.execute({
      source: { kind: "inbound", inboundId },
      traceId,
      initialMessages: [{ role: "user", content: "Read and connect" }],
      toolCallGuard: (call) =>
        call.name === "connections.connect" && completed > 0
          ? "Connection control must precede provider tools"
          : undefined,
    });

    expect(result).toMatchObject({ outcome: "bounded", response: expect.any(String) });
    expect(completed).toBe(1);
    expect(maximumActive).toBe(1);
  });

  it("removes a redundant hyphen before final reply arrows", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(
      harness.database,
      harness.traces,
      "Show recent work",
    );
    const model = scriptedModel([
      {
        id: "response_final",
        content: "📁 recent work:\n-\n› existing item\n- › first item\n  -  › second item",
        providerState: null,
        toolCalls: [],
        finishReason: "stop",
        usage: emptyUsage,
      },
    ]);
    const normalized =
      "📁 recent work:\n-\n› existing item\n› first item\n› second item";
    const loop = createAgentLoop(
      harness.runs,
      harness.writes,
      model,
      new ToolRegistry([]),
    );

    const result = await loop.execute({
      source: { kind: "inbound", inboundId },
      traceId,
      initialMessages: [{ role: "user", content: "Show recent work" }],
    });

    expect(result).toMatchObject({
      outcome: "completed",
      response: normalized,
    });
    expect(harness.runs.getRequired(result.run.id).finalResponse).toBe(normalized);
  });

  it("resumes a committed tool result without executing the provider operation again", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(harness.database, harness.traces, "Resume");
    const run = harness.runs.startOrResume({ source: { kind: "inbound", inboundId }, traceId, deadlineAtMs: Date.now() + 60_000 });
    const call = { id: "durable_call", name: "test.echo", argumentsJson: "{\"value\":\"saved\"}" };
    harness.runs.appendInitialMessages(run.id, [
      { role: "system", content: "Resume safely." },
      { role: "user", content: "Resume" },
    ]);
    harness.runs.appendAssistant(run.id, {
      id: "prior_response",
      content: "",
      providerState: "Persist this",
      toolCalls: [call],
      finishReason: "tool_calls",
      usage: emptyUsage,
    });
    const execution = harness.runs.prepareTool({
      runId: run.id,
      call,
      operationClass: "read",
      maximumToolCalls: 4,
    });
    harness.runs.markToolRunning(execution.id);
    harness.runs.finishTool(execution.id, "succeeded", { ok: true, value: "saved" });
    let providerExecutions = 0;
    const registry = new ToolRegistry([
      {
        ...echoTool,
        async execute() {
          providerExecutions += 1;
          return { ok: true, value: "repeated" };
        },
      },
    ]);
    const model = scriptedModel([
      {
        id: "resumed_final",
        content: "Recovered.",
        providerState: "Used the durable result",
        toolCalls: [],
        finishReason: "stop",
        usage: emptyUsage,
      },
    ]);

    const result = await createAgentLoop(harness.runs, harness.writes, model, registry).execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [], });

    expect(result.response).toBe("Recovered.");
    expect(providerExecutions).toBe(0);
    expect(
      harness.runs
        .loadMessages(run.id)
        .find(
          (message) => message.role === "tool" && message.toolCallId === "durable_call",
        ),
    ).toEqual({
      role: "tool",
      toolCallId: "durable_call",
      content: "{\"ok\":true,\"value\":\"saved\"}",
    });
  });

  it("bounds final responses to the outbound message character limit", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(harness.database, harness.traces, "Be concise");
    const model = scriptedModel([
      {
        id: "oversized_final",
        content: "x".repeat(18_997),
        providerState: null,
        toolCalls: [],
        finishReason: "stop",
        usage: emptyUsage,
      },
    ]);

    const result = await createAgentLoop(
      harness.runs,
      harness.writes,
      model,
      ToolRegistry.empty(),
    ).execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [{ role: "user", content: "Be concise" }], });

    expect(result).toMatchObject({
      outcome: "bounded",
      run: { failureCode: "response_too_large" },
    });
  });

  it("does not dispatch a persisted write after the durable run deadline", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(harness.database, harness.traces, "Too late");
    const run = harness.runs.startOrResume({ source: { kind: "inbound", inboundId }, traceId, deadlineAtMs: Date.now() - 1 });
    const call = {
      id: "expired_write",
      name: "test.write",
      argumentsJson: "{\"value\":\"stale\"}",
    };
    harness.runs.appendInitialMessages(run.id, [{ role: "user", content: "Too late" }]);
    harness.runs.appendAssistant(run.id, {
      id: "expired_response",
      content: "",
      providerState: "A stale provider write",
      toolCalls: [call],
      finishReason: "tool_calls",
      usage: emptyUsage,
    });
    let providerExecutions = 0;
    const registry = new ToolRegistry([
      {
        definition: {
          name: "test.write",
          description: "Writes a value.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        operationClass: "write",
        async execute() {
          providerExecutions += 1;
          return { ok: true };
        },
      },
    ]);

    const result = await createAgentLoop(
      harness.runs,
      harness.writes,
      scriptedModel([]),
      registry,
    ).execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [], });

    expect(result).toMatchObject({ outcome: "bounded", run: { failureCode: "run_deadline" } });
    expect(providerExecutions).toBe(0);
  });

  it("marks a dispatched running write ambiguous instead of re-executing it after a crash", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(harness.database, harness.traces, "Write once");
    const run = harness.runs.startOrResume({ source: { kind: "inbound", inboundId }, traceId, deadlineAtMs: Date.now() + 60_000 });
    const call = {
      id: "write_call",
      name: "test.write",
      argumentsJson: "{\"value\":\"once\"}",
    };
    harness.runs.appendInitialMessages(run.id, [{ role: "user", content: "Write once" }]);
    harness.runs.appendAssistant(run.id, {
      id: "write_response",
      content: "",
      providerState: "One provider write",
      toolCalls: [call],
      finishReason: "tool_calls",
      usage: emptyUsage,
    });
    const execution = harness.runs.prepareTool({
      runId: run.id,
      call,
      operationClass: "write",
      maximumToolCalls: 4,
    });
    harness.runs.markToolRunning(execution.id);
    const write = harness.writes.prepare({
      traceId,
      runId: run.id,
      toolExecutionId: execution.id,
      kind: "notion_update_page",
      request: { value: "once" },
      safeSummary: { operation: "update page" },
    });
    expect(
      harness.writes.prepare({
        traceId,
        runId: run.id,
        toolExecutionId: execution.id,
        kind: "notion_update_page",
        request: { value: "once" },
        safeSummary: { operation: "update page" },
      }).id,
    ).toBe(write.id);
    harness.writes.beginAttempt({ writeId: write.id, traceId });
    let providerExecutions = 0;
    const registry = new ToolRegistry([
      {
        definition: {
          name: "test.write",
          description: "Writes once.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        operationClass: "write",
        async execute() {
          providerExecutions += 1;
          return { ok: true };
        },
      },
    ]);

    const result = await createAgentLoop(
      harness.runs,
      harness.writes,
      scriptedModel([]),
      registry,
    ).execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [],
    replay: true, });

    expect(providerExecutions).toBe(0);
    expect(result).toMatchObject({
      outcome: "bounded",
      response: "I stopped because the provider may have accepted a write. I did not repeat it.",
      run: { phase: "blocked", failureCode: "ambiguous_write" },
    });
    expect(harness.writes.get(write.id)?.state).toBe("ambiguous");
    expect(harness.runs.getToolRequired(execution.id).status).toBe("ambiguous");
  });

  it("stops before executing a tool round beyond the configured bound", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(harness.database, harness.traces, "Loop forever");
    let executions = 0;
    const registry = new ToolRegistry([
      {
        ...echoTool,
        async execute() {
          executions += 1;
          return { ok: true };
        },
      },
    ]);
    const model = scriptedModel([
      toolResponse("first_round", "call_first"),
      toolResponse("second_round", "call_second"),
    ]);
    const loop = new AgentLoop({
      model,
      tools: registry,
      runs: harness.runs,
      writes: harness.writes,
      limits: {
        maxToolRounds: 1,
        maxToolCalls: 4,
        maxProviderWrites: 1,
        maxRunMs: 60_000,
      },
    });

    const result = await loop.execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [{ role: "user", content: "Loop forever" }], });

    expect(result.outcome).toBe("bounded");
    expect(result.run).toMatchObject({ phase: "blocked", failureCode: "round_limit" });
    expect(executions).toBe(1);
  });

  it("executes six brief reads split across bounded tool rounds", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(
      harness.database,
      harness.traces,
      "Dry-run the daily brief",
    );
    const requests: ModelRequest[] = [];
    let executions = 0;
    const registry = new ToolRegistry([
      {
        ...echoTool,
        async execute() {
          executions += 1;
          return { ok: true };
        },
      },
    ]);
    const calls = Array.from({ length: 6 }, (_, index) => ({
      id: `call_${index}`,
      name: "test.echo",
      argumentsJson: `{"value":"${index}"}`,
    }));
    const model = scriptedModel(
      [
        {
          id: "first_brief_batch",
          content: "",
          providerState: "Run the first four reads",
          toolCalls: calls.slice(0, 4),
          finishReason: "tool_calls",
          usage: emptyUsage,
        },
        {
          id: "second_brief_batch",
          content: "",
          providerState: "Run the remaining two reads",
          toolCalls: calls.slice(4),
          finishReason: "tool_calls",
          usage: emptyUsage,
        },
        {
          id: "brief_done",
          content: "All six reads are complete.",
          providerState: "Summarize six reads",
          toolCalls: [],
          finishReason: "stop",
          usage: emptyUsage,
        },
      ],
      requests,
    );

    const result = await createAgentLoop(
      harness.runs,
      harness.writes,
      model,
      registry,
    ).execute({
      source: { kind: "inbound", inboundId },
      traceId,
      initialMessages: [{ role: "user", content: "Dry-run the daily brief" }],
    });

    expect(result).toMatchObject({
      outcome: "completed",
      response: "All six reads are complete.",
      run: { toolCalls: 6 },
    });
    expect(executions).toBe(6);
    expect(requests).toHaveLength(3);
    expect(
      requests.every((request) =>
        request.messages
          .at(-1)
          ?.content.includes("The runtime rejects the entire response before any tool executes"),
      ),
    ).toBe(true);
  });

  it("executes none of five tool calls returned in one model response", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(
      harness.database,
      harness.traces,
      "Too many calls",
    );
    let executions = 0;
    const registry = new ToolRegistry([
      {
        ...echoTool,
        async execute() {
          executions += 1;
          return { ok: true };
        },
      },
    ]);
    const calls = Array.from({ length: 5 }, (_, index) => ({
      id: `call_${index}`,
      name: "test.echo",
      argumentsJson: `{\"value\":\"${index}\"}`,
    }));
    const model = scriptedModel([
      {
        id: "too_many_calls",
        content: "",
        providerState: "Try five calls",
        toolCalls: calls,
        finishReason: "tool_calls",
        usage: emptyUsage,
      },
    ]);

    const result = await createAgentLoop(
      harness.runs,
      harness.writes,
      model,
      registry,
    ).execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [{ role: "user", content: "Too many calls" }], });

    expect(result).toMatchObject({
      outcome: "bounded",
      run: { phase: "blocked", failureCode: "tool_response_limit", toolCalls: 0 },
    });
    expect(executions).toBe(0);
  });

  it("loads only bounded completed history from the same chat", () => {
    const harness = agentHarness();
    const first = insertInbound(harness.database, harness.traces, "First", 1);
    const firstRun = harness.runs.startOrResume({ source: { kind: "inbound", inboundId: first.inboundId }, traceId: first.traceId, deadlineAtMs: Date.now() + 60_000 });
    harness.runs.complete(firstRun.id, "First answer");
    const second = insertInbound(harness.database, harness.traces, "Second", 2);
    const secondRun = harness.runs.startOrResume({ source: { kind: "inbound", inboundId: second.inboundId }, traceId: second.traceId, deadlineAtMs: Date.now() + 60_000 });
    harness.runs.complete(secondRun.id, "Second answer");
    const current = insertInbound(harness.database, harness.traces, "Current", 3);

    expect(
      new ConversationHistoryStore(harness.database.handle.db, 2, 1_024).loadBefore(
        current.inboundId,
      ),
    ).toEqual([
      { role: "user", content: "Second" },
      { role: "assistant", content: "Second answer" },
    ]);
    expect(
      new ConversationHistoryStore(harness.database.handle.db, 2, 1).loadBefore(
        current.inboundId,
      ),
    ).toEqual([]);
  });

  it("keeps retired status-action JSON out of later conversation history", () => {
    const harness = agentHarness();
    const prior = insertInbound(
      harness.database,
      harness.traces,
      "What accounts do I have?",
      1,
    );
    const priorRun = harness.runs.startOrResume({
      source: { kind: "inbound", inboundId: prior.inboundId },
      traceId: prior.traceId,
      deadlineAtMs: Date.now() + 60_000,
    });
    harness.runs.complete(
      priorRun.id,
      '{"action":"connection_status","message":"let me check your connected accounts for you."}',
    );
    const current = insertInbound(harness.database, harness.traces, "Hello again", 2);

    expect(
      new ConversationHistoryStore(harness.database.handle.db, 2, 1_024).loadBefore(
        current.inboundId,
      ),
    ).toEqual([
      { role: "user", content: "What accounts do I have?" },
      {
        role: "assistant",
        content: "let me check your connected accounts for you.",
      },
    ]);
  });

  it("keeps fenced retired connect actions out of conversation history", () => {
    const harness = agentHarness();
    const prior = insertInbound(
      harness.database,
      harness.traces,
      "Please send me the link to connect a Google account",
      1,
    );
    const priorRun = harness.runs.startOrResume({
      source: { kind: "inbound", inboundId: prior.inboundId },
      traceId: prior.traceId,
      deadlineAtMs: Date.now() + 60_000,
    });
    harness.runs.complete(
      priorRun.id,
      [
        "```json",
        "{",
        '  \"action\": \"connect\",',
        '  \"provider\": \"google\",',
        `  "message": "here's the link to connect your google account:"`,
        "}",
        "```",
      ].join("\n"),
    );
    const current = insertInbound(harness.database, harness.traces, "Hello again", 2);

    expect(
      new ConversationHistoryStore(harness.database.handle.db, 2, 1_024).loadBefore(
        current.inboundId,
      ),
    ).toEqual([
      {
        role: "user",
        content: "Please send me the link to connect a Google account",
      },
      {
        role: "assistant",
        content: "here's the link to connect your google account:",
      },
    ]);
  });

  it("omits unfulfilled connect runs but retains fulfilled replies in later history", () => {
    const harness = agentHarness();
    const unfulfilled = insertInbound(
      harness.database,
      harness.traces,
      "Connect my Google account",
      1,
    );
    const unfulfilledRun = harness.runs.startOrResume({
      source: { kind: "inbound", inboundId: unfulfilled.inboundId },
      traceId: unfulfilled.traceId,
      deadlineAtMs: Date.now() + 60_000,
    });
    const unfulfilledExecution = harness.runs.prepareTool({
      runId: unfulfilledRun.id,
      call: {
        id: "unfulfilled_connect",
        name: "connections.connect",
        argumentsJson: '{"provider":"google"}',
      },
      operationClass: "read",
      maximumToolCalls: 4,
    });
    harness.runs.markToolRunning(unfulfilledExecution.id);
    harness.runs.finishTool(unfulfilledExecution.id, "succeeded", {
      provider: "google",
      connectionLinkWillBeAppended: true,
    });
    harness.runs.complete(unfulfilledRun.id, "Use evil.example/connect instead.");

    const fulfilled = insertInbound(
      harness.database,
      harness.traces,
      "Connect my Notion account",
      2,
    );
    const fulfilledRun = harness.runs.startOrResume({
      source: { kind: "inbound", inboundId: fulfilled.inboundId },
      traceId: fulfilled.traceId,
      deadlineAtMs: Date.now() + 60_000,
    });
    const fulfilledExecution = harness.runs.prepareTool({
      runId: fulfilledRun.id,
      call: {
        id: "fulfilled_connect",
        name: "connections.connect",
        argumentsJson: '{"provider":"notion"}',
      },
      operationClass: "read",
      maximumToolCalls: 4,
    });
    harness.runs.markToolRunning(fulfilledExecution.id);
    harness.runs.finishTool(fulfilledExecution.id, "succeeded", {
      provider: "notion",
      connectionLinkWillBeAppended: true,
    });
    harness.runs.complete(fulfilledRun.id, "Open the secure link below.");
    harness.traces.append({
      traceId: fulfilled.traceId,
      component: "connection_control",
      event: "connect_fulfilled",
      outcome: "notion",
      runId: fulfilledRun.id,
    });

    const current = insertInbound(harness.database, harness.traces, "Hello again", 3);
    expect(
      new ConversationHistoryStore(harness.database.handle.db, 6, 1_024).loadBefore(
        current.inboundId,
      ),
    ).toEqual([
      { role: "user", content: "Connect my Notion account" },
      { role: "assistant", content: "Open the secure link below." },
    ]);
  });

  it("keeps unexpected provider error details out of the model transcript", async () => {
    const harness = agentHarness();
    const { inboundId, traceId } = insertInbound(
      harness.database,
      harness.traces,
      "Read from the provider",
    );
    const requests: ModelRequest[] = [];
    const model = scriptedModel(
      [
        {
          id: "response_tool_error",
          content: "",
          providerState: null,
          toolCalls: [
            { id: "call_error", name: "test.echo", argumentsJson: '{"value":"read"}' },
          ],
          finishReason: "tool_calls",
          usage: emptyUsage,
        },
        {
          id: "response_after_error",
          content: "The provider read failed.",
          providerState: null,
          toolCalls: [],
          finishReason: "stop",
          usage: emptyUsage,
        },
      ],
      requests,
    );
    const registry = new ToolRegistry([
      {
        ...echoTool,
        async execute() {
          throw new Error("credential bearer-secret and connection conn_internal");
        },
      },
    ]);
    const loop = createAgentLoop(harness.runs, harness.writes, model, registry);

    await loop.execute({ source: { kind: "inbound", inboundId }, traceId, initialMessages: [{ role: "user", content: "Read from the provider" }], });

    const toolMessage = requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage).toEqual({
      role: "tool",
      toolCallId: "call_error",
      content:
        '{"error":{"code":"tool_failed","message":"The tool failed at its provider boundary"},"ok":false}',
    });
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("bearer-secret");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("conn_internal");
  });

  it("rejects invalid tool arguments before invoking the handler", async () => {
    let executions = 0;
    const registry = new ToolRegistry([
      {
        ...echoTool,
        async execute() {
          executions += 1;
          return null;
        },
      },
    ]);

    await expect(
      registry.execute({
        name: "test.echo",

        argumentsJson: "{\"unexpected\":true}",
        context: {
          runId: newRunId(),
          traceId: newTraceId(),
          toolExecutionId: "tool_test" as never,
          connectionId: null,
          replay: false,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(executions).toBe(0);
  });
});

const emptyUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};
const echoTool: RegisteredTool = {
  definition: {
    name: "test.echo",
    description: "Returns a value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  operationClass: "read",
  batchMode: "parallel_read",
  async execute(argumentsValue) {
    return { ok: true, value: argumentsValue.value };
  },
};

function modelHarness(overrides: Record<string, string> = {}): {
  database: TestDatabase;
  config: RuntimeConfig;
  traces: TraceStore;
} {
  const database = createTestDatabase();
  databases.push(database);
  return {
    database,
    config: testRuntimeConfig(database, overrides),
    traces: new TraceStore(database.handle.db, createTraceRedactor([])),
  };
}

function agentHarness(): {
  database: TestDatabase;
  traces: TraceStore;
  runs: AgentRunStore;
  writes: WriteStore;
} {
  const database = createTestDatabase();
  databases.push(database);
  const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
  return {
    database,
    traces,
    runs: new AgentRunStore(database.handle.db, traces),
    writes: new WriteStore(database.handle.db, traces),
  };
}

function insertInbound(
  database: TestDatabase,
  traces: TraceStore,
  text: string,
  sequence = 1,
): { inboundId: InboundId; traceId: TraceId } {
  const inboundId = newInboundId();
  const traceId = newTraceId();
  const deliveryId = `delivery_${randomUUID()}`;
  const providerMessageId = `message_${randomUUID()}`;
  const now = Date.now();
  traces.append({
    traceId,
    component: "test",
    event: "inbound_fixture",
    outcome: "ready",
    data: {},
  });
  const transaction = database.handle.db.transaction(() => {
    database.handle.db
      .prepare(`
        INSERT INTO webhook_deliveries(
          id, provider_delivery_id, provider_message_id, event_kind, line_id,
          line_handle, outbox_id, normalized_json, trace_id, received_at_ms
        ) VALUES (?, ?, ?, 'message.created', 'line_test', '+15551110000', NULL, '{}', ?, ?)
      `)
      .run(deliveryId, deliveryId, providerMessageId, traceId, now);
    database.handle.db
      .prepare(`
        INSERT INTO inbound_messages(
          id, delivery_id, provider_message_id, chat_id, guid, sender,
          line_id, line_handle, sequence, state, text, is_audio,
          attachment_json, trace_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'chat_test', ?, '+15559990000',
                  'line_test', '+15551110000', ?, 'ready', ?, 0,
                  NULL, ?, ?, ?)
      `)
      .run(inboundId, deliveryId, providerMessageId, providerMessageId, sequence, text, traceId, now, now);
  });
  transaction.immediate();
  return { inboundId, traceId };
}

function scriptedModel(
  responses: readonly ModelResponse[],
  requests: ModelRequest[] = [],
): ChatModel {
  let index = 0;
  return {
    async complete(request) {
      requests.push(request);
      const response = responses[index];
      index += 1;
      if (response === undefined) {
        throw new Error("No scripted model response remains");
      }
      return response;
    },
  };
}

function createAgentLoop(
  runs: AgentRunStore,
  writes: WriteStore,
  model: ChatModel,
  tools: ToolRegistry,
): AgentLoop {
  return new AgentLoop({
    model,
    tools,
    runs,
    writes,
    limits: {
      maxToolRounds: 4,
      maxToolCalls: 8,
      maxProviderWrites: 2,
      maxRunMs: 60_000,
    },
  });
}

function toolResponse(id: string, callId: string): ModelResponse {
  return {
    id,
    content: "",
    providerState: "Keep using the tool",
    toolCalls: [
      { id: callId, name: "test.echo", argumentsJson: "{\"value\":\"again\"}" },
    ],
    finishReason: "tool_calls",
    usage: emptyUsage,
  };
}

function completionResponse(choice: {
  id?: string;
  finish_reason: string;
  message: Record<string, unknown>;
}): Response {
  return new Response(
    JSON.stringify({
      ...(choice.id === undefined ? {} : { id: choice.id }),
      choices: [{ finish_reason: choice.finish_reason, message: choice.message }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function testRuntimeConfig(
  database: TestDatabase,
  overrides: Record<string, string> = {},
): RuntimeConfig {
  return loadRuntimeConfig({
    NODE_ENV: "test",
    DATA_DIR: database.directory,
    DATABASE_PATH: database.config.databasePath,
    MEMORY_PATH: database.config.memoryPath,
    TRACE_DIR: database.config.traceDir,
    SENDBLUE_API_KEY_ID: "sendblue_test_key_id",
    SENDBLUE_API_SECRET_KEY: "sendblue_test_secret_key",
    SENDBLUE_FROM_NUMBER: "+15551112222",
    SENDBLUE_BASE_URL: "https://api.sendblue.co",
    USER_PHONE_NUMBER: "+15559990000",
    PUBLIC_BASE_URL: "https://assistant.example",
    DEEPSEEK_API_KEY: "deepseek_test_key",
    GOOGLE_CLIENT_ID: "google_test_client",
    GOOGLE_CLIENT_SECRET: "google_test_secret",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  });
}
