import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunStore } from "../src/agent/store.js";
import { ToolRegistry, type ToolExecutionContext } from "../src/agent/tools.js";
import { newInboundId, newTraceId } from "../src/core/ids.js";
import type { ProviderFetch } from "../src/providers/fetch.js";
import { loadTodoConfig } from "../src/todo/config.js";
import { TodoToolService, todoToolNames } from "../src/todo/tools.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { WriteStore } from "../src/writes/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const token = "synthetic-todo-token-never-for-model";
const todo = {
  id: "df87b1e1-6540-4f37-adfe-606213cc278a", title: "Buy tea", notes: "Loose leaf",
  dueDate: "2026-10-29", priority: "medium", completedAt: null, position: 0, revision: 1,
  createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.000Z",
};
const databases: TestDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.cleanup(); });

function harness(fetchImpl: ProviderFetch, timeoutMs = 1_000) {
  const database = createTestDatabase();
  databases.push(database);
  const db = database.handle.db;
  const traces = new TraceStore(db, createTraceRedactor([token]));
  const writes = new WriteStore(db, traces);
  const runs = new AgentRunStore(db, traces);
  const traceId = newTraceId();
  traces.append({ traceId, component: "test", event: "started" });
  const inboundId = newInboundId();
  const deliveryId = randomUUID();
  db.prepare(`INSERT INTO webhook_deliveries(
    id, provider_delivery_id, provider_message_id, event_kind, line_id,
    line_handle, outbox_id, normalized_json, trace_id, received_at_ms
  ) VALUES (?, ?, ?, 'message.created', 'line_test', '+15551110000', NULL, '{}', ?, 1)`)
    .run(deliveryId, deliveryId, deliveryId, traceId);
  db.prepare(`INSERT INTO inbound_messages(
    id, delivery_id, provider_message_id, chat_id, guid, sender, line_id, line_handle,
    sequence, state, text, is_audio, attachment_json, trace_id, created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, 'chat_test', ?, '+15559990000', 'line_test', '+15551110000',
    1, 'ready', 'Update my task', 0, NULL, ?, 1, 1)`)
    .run(inboundId, deliveryId, deliveryId, deliveryId, traceId);
  const run = runs.startOrResume({ source: { kind: "inbound", inboundId }, traceId, deadlineAtMs: Date.now() + 60_000 });
  const registry = new ToolRegistry(new TodoToolService({
    db, config: { apiUrl: "https://todo.example.com", agentToken: token }, traces, writes, fetchImpl, timeoutMs,
  }).tools());
  const context = (name: string, args: unknown): ToolExecutionContext => {
    const execution = runs.prepareTool({
      runId: run.id, call: { id: randomUUID(), name, argumentsJson: JSON.stringify(args) },
      operationClass: registry.operationClass(name), maximumToolCalls: 32,
    });
    runs.markToolRunning(execution.id);
    return { runId: run.id, traceId, toolExecutionId: execution.id, connectionId: null, replay: false };
  };
  const call = (name: string, args: unknown, overrides: Partial<ToolExecutionContext> = {}) => registry.execute({
    name, argumentsJson: JSON.stringify(args), context: { ...context(name, args), ...overrides },
  });
  const states = () => db.prepare<[], { state: string }>("SELECT state FROM write_intents ORDER BY created_at_ms, id").all().map((row) => row.state);
  return { db, registry, call, states };
}

describe("optional simple-to-do configuration", () => {
  it("is disabled without both variables and rejects partial configuration", () => {
    expect(loadTodoConfig({}, "production")).toBeUndefined();
    expect(() => loadTodoConfig({ TODO_API_URL: "https://todo.example.com" }, "test")).toThrow();
    expect(() => loadTodoConfig({ TODO_AGENT_TOKEN: token }, "test")).toThrow();
    expect(() => loadTodoConfig({ TODO_API_URL: "https://todo.example.com", TODO_AGENT_TOKEN: "short" }, "production")).toThrow();
  });

  it.each([
    "http://todo.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]",
    "https://10.0.0.1", "https://todo.internal", "https://todo.local", "https://todo",
    "https://user:password@todo.example.com", "https://todo.example.com/api", "https://todo.example.com/?secret=1", "https://todo.example.com/#token",
  ])("rejects unsafe production URL %s", (url) => {
    expect(() => loadTodoConfig({ TODO_API_URL: url, TODO_AGENT_TOKEN: token }, "production")).toThrow();
  });

  it("allows loopback HTTP only outside production", () => {
    expect(loadTodoConfig({ TODO_API_URL: "http://localhost:3000/", TODO_AGENT_TOKEN: token }, "development"))
      .toEqual({ apiUrl: "http://localhost:3000", agentToken: token });
    expect(loadTodoConfig({ TODO_API_URL: "https://todo.example.com/", TODO_AGENT_TOKEN: token }, "production"))
      .toEqual({ apiUrl: "https://todo.example.com", agentToken: token });
  });
});

describe("simple-to-do tool boundary", () => {
  it("lists with bounded filters, authenticates server-side, and strips transport fields", async () => {
    const item = harness(async (input) => {
      const request = new Request(input);
      expect(request.url).toBe("https://todo.example.com/api/todos?dueDate=2026-10-29&status=open");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(request.redirect).toBe("error");
      return Response.json({ todos: [{ ...todo, credential: token }], credential: token });
    });
    expect(item.registry.definitions().map((tool) => tool.name)).toEqual(todoToolNames);
    expect(JSON.stringify(item.registry.definitions())).not.toContain(token);
    expect(await item.call("todo.list", { dueDate: "2026-10-29", status: "open" })).toEqual({ todos: [todo] });
    expect(item.states()).toEqual([]);
  });

  it("records dispatch durably before the provider can accept a mutation", async () => {
    const item = harness(async () => {
      expect(item.states()).toEqual(["attempting"]);
      return Response.json({ todo });
    });
    await item.call("todo.create", { title: "Buy tea" });
    expect(item.states()).toEqual(["succeeded"]);
    const request = item.db.prepare<[], { request_json: string }>("SELECT request_json FROM write_intents").get();
    expect(request?.request_json).not.toContain(token);
  });

  it.each([
    { name: "todo.delete", args: { id: todo.id, expectedRevision: 1 } },
    { name: "todo.delete", args: { id: todo.id, expectedRevision: 1, confirmed: false } },
    { name: "todo.delete", args: { id: todo.id, confirmed: true } },
    { name: "todo.complete", args: { expectedRevision: 1, completed: true } },
    { name: "todo.complete", args: { id: "Buy tea", expectedRevision: 1, completed: true } },
    { name: "todo.update", args: { id: todo.id, expectedRevision: 1 } },
    { name: "todo.create", args: { title: " " } },
    { name: "todo.create", args: { title: "Tea", dueDate: "2026-02-30" } },
    { name: "todo.reorder", args: { dueDate: null, items: [{ id: todo.id, revision: 1 }] } },
    { name: "todo.reorder", args: { dueDate: null, items: [{ id: todo.id, revision: 1 }, { id: todo.id, revision: 1 }], confirmed: true } },
  ])("rejects unsafe $name arguments before intent or request", async ({ name, args }) => {
    let requests = 0;
    const item = harness(async () => { requests += 1; return Response.json({}); });
    await expect(item.call(name, args)).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(requests).toBe(0);
    expect(item.states()).toEqual([]);
  });

  it("treats conflict as confirmed failure and forbids model-driven write retry in that run", async () => {
    let requests = 0;
    const item = harness(async () => { requests += 1; return Response.json({ error: token }, { status: 409 }); });
    expect(await item.call("todo.complete", { id: todo.id, expectedRevision: 1, completed: true }))
      .toMatchObject({ ok: false, error: { code: "todo_conflict" } });
    expect(item.states()).toEqual(["confirmed_failed"]);
    await expect(item.call("todo.complete", { id: todo.id, expectedRevision: 2, completed: true }))
      .rejects.toMatchObject({ code: "todo_retry_blocked" });
    expect(requests).toBe(1);
  });

  it.each(["network", "server", "malformed"])("records %s write acceptance as ambiguous without retry", async (failure) => {
    let requests = 0;
    const item = harness(async () => {
      requests += 1;
      if (failure === "network") throw new Error(token);
      return failure === "server" ? new Response("failed", { status: 503 }) : Response.json({ todo: { id: todo.id } });
    });
    expect(await item.call("todo.create", { title: "Buy tea" })).toMatchObject({ ok: false, error: { code: "acceptance_unknown" } });
    expect(item.states()).toEqual(["ambiguous"]);
    await expect(item.call("todo.create", { title: "Buy tea" })).rejects.toMatchObject({ code: "todo_retry_blocked" });
    expect(requests).toBe(1);
  });

  it("blocks replay writes before preparing an intent", async () => {
    let requests = 0;
    const item = harness(async () => { requests += 1; return Response.json({ todo }); });
    await expect(item.call("todo.create", { title: "Tea" }, { replay: true })).rejects.toMatchObject({ code: "replay_write_blocked" });
    expect(item.states()).toEqual([]);
    expect(requests).toBe(0);
  });

  it("honors a pre-aborted context before write preparation", async () => {
    const item = harness(async () => { throw new Error("Must not dispatch"); });
    await expect(item.call("todo.create", { title: "Tea" }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(item.states()).toEqual([]);
  });

  it("propagates cancellation during dispatch and does not repeat the mutation", async () => {
    const controller = new AbortController();
    const item = harness(async (_input, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("Expected abort");
    });
    expect(await item.call("todo.create", { title: "Tea" }, { signal: controller.signal }))
      .toMatchObject({ ok: false, error: { code: "acceptance_unknown" } });
    expect(item.states()).toEqual(["ambiguous"]);
  });

  it("bounds response body time and size", async () => {
    const oversized = harness(async () => new Response("x".repeat(1_048_577)));
    await expect(oversized.call("todo.list", {})).rejects.toMatchObject({ code: "todo_unavailable" });
    const slow = harness(async () => new Response(new ReadableStream({ start() {} })), 10);
    await expect(slow.call("todo.list", {})).rejects.toMatchObject({ code: "todo_unavailable" });
  });
});
