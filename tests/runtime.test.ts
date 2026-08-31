import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MemoryMaintenanceRequest,
  MemoryMaintenanceResponse,
  ModelRequest,
  ModelResponse,
} from "../src/agent/model.js";
import { AgentRunStore } from "../src/agent/store.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import { asInboundId, asTraceId, type TraceId } from "../src/core/ids.js";
import type { ClaimedJob, JobType } from "../src/queue/store.js";
import type { JobContext } from "../src/queue/worker.js";
import { createRuntime, type AssistantModel, type AssistantRuntime } from "../src/runtime.js";
import {
  MessagingProviderError,
  type DeliveryResource,
  type InboundMessage,
  type InboundPage,
  type InboundWakeStream,
  type MessageGateway,
} from "../src/messages/types.js";

const lineNumber = "+15551112222";
const userNumber = "+15559990000";
const foreignNumber = "+15550000000";

interface TrackedRuntime {
  runtime: AssistantRuntime;
  directory: string;
}

const tracked: TrackedRuntime[] = [];

afterEach(async () => {
  for (const item of tracked.splice(0)) {
    await item.runtime.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

class FakeModel implements AssistantModel {
  readonly requests: ModelRequest[] = [];
  readonly maintenanceRequests: MemoryMaintenanceRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      id: "response_1",
      content: "Hello back.",
      reasoningContent: null,
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    };
  }

  async maintainMemory(request: MemoryMaintenanceRequest): Promise<MemoryMaintenanceResponse> {
    this.maintenanceRequests.push(request);
    return {
      id: "memory_1",
      content: JSON.stringify({
        action: "replace",
        memory: "# Memory\n\n- User prefers concise replies.\n",
      }),
      usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 },
    };
  }
}

interface ListCall {
  updatedAtGteMs: number;
  limit: number;
  offset: number;
}

/**
 * In-memory Sendblue line: `inbox` is the provider-side message list, served
 * ascending by `updatedAtMs` with real `updated_at_gte`, offset, limit, and
 * total paging so overlapping sweeps observe genuine repeat listings.
 */
class FakeGateway implements MessageGateway {
  readonly inbox: InboundMessage[] = [];
  readonly listCalls: ListCall[] = [];
  readonly sends: { to: string; text: string; replyTo?: string }[] = [];
  readonly statusReads: string[] = [];
  readonly listErrors: Error[] = [];
  readonly sendErrors: Error[] = [];
  streamOpens = 0;
  sendStatus: DeliveryResource["status"] = "pending";
  deliveryStatus: DeliveryResource["status"] = "delivered";
  statusError: Error | undefined;
  #pendingWakes = 0;
  #wakeWaiter: (() => void) | undefined;
  #listWaiters: (() => void)[] = [];

  async listInbound(input: {
    updatedAtGteMs: number;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }): Promise<InboundPage> {
    this.listCalls.push({
      updatedAtGteMs: input.updatedAtGteMs,
      limit: input.limit,
      offset: input.offset,
    });
    for (const waiter of this.#listWaiters.splice(0)) {
      waiter();
    }
    input.signal.throwIfAborted();
    const failure = this.listErrors.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const matched = this.inbox
      .filter((message) => message.updatedAtMs >= input.updatedAtGteMs)
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs);
    return {
      messages: matched.slice(input.offset, input.offset + input.limit),
      total: matched.length,
      requestId: `req_list_${this.listCalls.length}`,
    };
  }

  async openInboundWakeStream(signal: AbortSignal): Promise<InboundWakeStream> {
    this.streamOpens += 1;
    return { events: this.#wakeEvents(signal), requestId: `req_stream_${this.streamOpens}` };
  }

  async send(input: { to: string; text: string; replyTo?: string }): Promise<DeliveryResource> {
    this.sends.push(input);
    const failure = this.sendErrors.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return {
      messageHandle: `msg_out_${this.sends.length}`,
      status: this.sendStatus,
      requestId: `req_send_${this.sends.length}`,
      error: null,
    };
  }

  async getStatus(messageHandle: string): Promise<DeliveryResource> {
    this.statusReads.push(messageHandle);
    if (this.statusError !== undefined) {
      throw this.statusError;
    }
    return {
      messageHandle,
      status: this.deliveryStatus,
      requestId: `req_status_${this.statusReads.length}`,
      error: null,
    };
  }

  /** Resolves when the receiver issues its next inbound list request. */
  nextList(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#listWaiters.push(resolve);
    return promise;
  }

  /** Mimics one `message.received` server-sent event reaching the receiver. */
  emitWake(): void {
    this.#pendingWakes += 1;
    const waiter = this.#wakeWaiter;
    this.#wakeWaiter = undefined;
    waiter?.();
  }

  async *#wakeEvents(signal: AbortSignal): AsyncGenerator<void> {
    while (!signal.aborted) {
      if (this.#pendingWakes > 0) {
        this.#pendingWakes -= 1;
        yield;
        continue;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      const done = () => {
        signal.removeEventListener("abort", done);
        if (this.#wakeWaiter === done) {
          this.#wakeWaiter = undefined;
        }
        resolve();
      };
      this.#wakeWaiter = done;
      signal.addEventListener("abort", done, { once: true });
      await promise;
    }
  }
}

describe("production runtime", () => {
  it("carries a swept trusted message through agent, memory, egress, and delivery", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway);
    item.runtime.setReady(true);
    gateway.inbox.push(inboundMessage("msg_trusted"));

    const health = await item.runtime.app.inject({ method: "GET", url: "/health" });
    await sweep(item);

    expect(health.statusCode).toBe(200);
    expect(count(item.runtime, "inbound_messages")).toBe(1);
    expect(count(item.runtime, "jobs")).toBe(1);

    await runNextJob(item.runtime, Date.now() + 10);

    expect(model.requests).toHaveLength(1);
    expect(model.maintenanceRequests).toHaveLength(1);
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "gmail.search",
      "gmail.read_thread",
      "gmail.create_draft",
      "gmail.send_draft",
      "notion.search",
      "notion.fetch",
      "notion.create_page",
      "notion.update_page",
    ]);
    expect(readFileSync(join(item.directory, "MEMORY.md"), "utf8")).toContain(
      "User prefers concise replies",
    );

    const traceId = acceptedTraceId(item.runtime);
    const chronology = item.runtime.traces.list(traceId);
    const ingressAccepted = chronology.findIndex(
      (event) => event.component === "ingress" && event.event === "accepted",
    );
    const agentCompleted = chronology.findIndex(
      (event) => event.component === "agent" && event.event === "completed",
    );
    const memoryUpdated = chronology.findIndex(
      (event) => event.component === "memory" && event.event === "updated",
    );
    const egressPrepared = chronology.findIndex(
      (event) => event.component === "egress" && event.event === "prepared",
    );
    expect(ingressAccepted).toBeGreaterThan(-1);
    expect(agentCompleted).toBeGreaterThan(ingressAccepted);
    expect(memoryUpdated).toBeGreaterThan(agentCompleted);
    expect(egressPrepared).toBeGreaterThan(memoryUpdated);

    await runNextJob(item.runtime, Date.now() + 100);
    await runNextJob(item.runtime, Date.now() + 2_000);

    expect(gateway.sends).toEqual([
      { to: userNumber, text: "Hello back.", replyTo: "msg_trusted" },
    ]);
    expect(gateway.statusReads).toEqual(["msg_out_1"]);
    expect(egressState(item.runtime)).toBe("delivered");
    expect(
      item.runtime.database.db
        .prepare<{ trace_id: string }, { state: string }>(
          "SELECT state FROM trace_streams WHERE trace_id = @trace_id",
        )
        .get({ trace_id: traceId })?.state,
    ).toBe("exported");

    item.runtime.projector.projectPending();
    const traceText = readFileSync(join(item.directory, "traces", `${traceId}.jsonl`), "utf8");
    expect(traceText).toContain('"event":"delivered"');
  });

  it("accepts only the trusted sender on the assistant line", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway);
    gateway.inbox.push(
      inboundMessage("msg_foreign_sender", {
        senderNumber: foreignNumber,
        contactNumber: foreignNumber,
      }),
      inboundMessage("msg_foreign_line", {
        lineNumber: foreignNumber,
        recipientNumber: foreignNumber,
      }),
      inboundMessage("msg_group", { messageType: "group", groupId: "group_1" }),
      inboundMessage("msg_trusted"),
    );

    await sweep(item);

    expect(
      item.runtime.database.db
        .prepare<[], { sender: string; guid: string }>("SELECT sender, guid FROM inbound_messages")
        .all(),
    ).toEqual([{ sender: userNumber, guid: "msg_trusted" }]);
    expect(count(item.runtime, "jobs")).toBe(1);
    expect(model.requests).toHaveLength(0);
  });

  it("does not duplicate durable work when overlapping sweeps re-list a message", async () => {
    const gateway = new FakeGateway();
    const item = await newRuntime(new FakeModel(), gateway);
    gateway.inbox.push(inboundMessage("msg_repeat"));

    await sweep(item);
    await sweep(item);
    await sweep(item);

    expect(count(item.runtime, "inbound_messages")).toBe(1);
    expect(count(item.runtime, "jobs")).toBe(1);
    expect(gateway.listCalls).toHaveLength(3);
    const [first, second] = gateway.listCalls;
    expect(first?.offset).toBe(0);
    // The first sweep resumes at the durable cursor; later sweeps re-read an
    // overlap window behind it, so the same message is listed again.
    expect(second?.updatedAtGteMs).toBeLessThan(first?.updatedAtGteMs ?? 0);

    await runNextJob(item.runtime, Date.now() + 10);

    expect(count(item.runtime, "agent_runs")).toBe(1);
    expect(inboundState(item.runtime)).toBe("done");
  });

  it("starts without contacting Sendblue or the model and exposes no inbound webhook", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway);
    item.runtime.setReady(true);

    const health = await item.runtime.app.inject({ method: "GET", url: "/health" });
    const webhook = await item.runtime.app.inject({
      method: "POST",
      url: "/webhooks/messages",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "message.received" }),
    });

    expect(health.statusCode).toBe(200);
    expect(webhook.statusCode).toBe(404);
    expect(model.requests).toHaveLength(0);
    expect(model.maintenanceRequests).toHaveLength(0);
    expect(gateway.listCalls).toHaveLength(0);
    expect(gateway.streamOpens).toBe(0);
    expect(gateway.sends).toHaveLength(0);
    expect(gateway.statusReads).toHaveLength(0);
  });

  it("handles connect commands without exposing them to the model", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway);
    gateway.inbox.push(inboundMessage("msg_connect", { text: "connect Google" }));

    await sweep(item);
    await runNextJob(item.runtime, Date.now() + 10);

    const reply = item.runtime.database.db
      .prepare<[], { body: string }>("SELECT body FROM egress_messages WHERE purpose = 'recovery'")
      .get();
    expect(model.requests).toHaveLength(0);
    expect(model.maintenanceRequests).toHaveLength(0);
    expect(reply?.body).toMatch(
      /^Connect another Google account: https:\/\/assistant\.example\/connect\/google\?token=/u,
    );
    expect(inboundState(item.runtime)).toBe("done");
  });

  it("plans a failure notice for a media-only message instead of calling the model", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway);
    gateway.inbox.push(inboundMessage("msg_media", { text: null, hasMedia: true }));

    await sweep(item);
    await runNextJob(item.runtime, Date.now() + 10);

    expect(model.requests).toHaveLength(0);
    expect(inboundState(item.runtime)).toBe("blocked");
    expect(
      item.runtime.database.db
        .prepare<[], { purpose: string; reply_to_guid: string | null }>(
          "SELECT purpose, reply_to_guid FROM egress_messages",
        )
        .all(),
    ).toEqual([{ purpose: "failure", reply_to_guid: "msg_media" }]);
  });

  it("keeps inbound work reachable after a transient list failure", async () => {
    const gateway = new FakeGateway();
    const item = await newRuntime(new FakeModel(), gateway);
    gateway.inbox.push(inboundMessage("msg_after_outage"));
    gateway.listErrors.push(
      new MessagingProviderError({
        kind: "transient",
        message: "sendblue unavailable",
        status: 503,
      }),
    );

    await expect(sweep(item)).rejects.toBeInstanceOf(MessagingProviderError);

    expect(count(item.runtime, "inbound_messages")).toBe(0);
    expect(count(item.runtime, "jobs")).toBe(0);

    await sweep(item);

    expect(count(item.runtime, "inbound_messages")).toBe(1);
    expect(count(item.runtime, "jobs")).toBe(1);
    // A failed sweep must not advance recovery, so the retry reads the same floor.
    expect(gateway.listCalls[1]?.updatedAtGteMs).toBe(gateway.listCalls[0]?.updatedAtGteMs);
  });

  it("never replays a send whose acceptance is ambiguous", async () => {
    const gateway = new FakeGateway();
    const item = await newRuntime(new FakeModel(), gateway);
    gateway.inbox.push(inboundMessage("msg_ambiguous"));
    gateway.sendErrors.push(
      new MessagingProviderError({ kind: "ambiguous", message: "socket hang up" }),
    );

    await sweep(item);
    await runNextJob(item.runtime, Date.now() + 10);
    await runNextJob(item.runtime, Date.now() + 100);

    expect(gateway.sends).toHaveLength(1);
    expect(egressState(item.runtime)).toBe("acceptance_unknown");
    expect(
      item.runtime.database.db
        .prepare<[], { state: string }>(
          "SELECT state FROM write_intents WHERE kind = 'sendblue_send_message'",
        )
        .get()?.state,
    ).toBe("ambiguous");
    expect(runnableJobs(item.runtime, "egress_send")).toBe(0);
    expect(runnableJobs(item.runtime, "egress_reconcile")).toBe(0);
  });

  it("terminalizes delivery when reconciliation retries are exhausted", async () => {
    const gateway = new FakeGateway();
    const item = await newRuntime(new FakeModel(), gateway);
    gateway.inbox.push(inboundMessage("msg_retry_limit"));

    await sweep(item);
    await runNextJob(item.runtime, Date.now() + 10);
    await runNextJob(item.runtime, Date.now() + 100);
    item.runtime.database.db
      .prepare("UPDATE jobs SET attempts = 15 WHERE type = 'egress_reconcile'")
      .run();
    gateway.statusError = new MessagingProviderError({
      kind: "transient",
      message: "provider unavailable",
      status: 503,
    });

    await runNextJob(item.runtime, Date.now() + 2_000);

    expect(gateway.statusReads).toEqual(["msg_out_1"]);
    expect(egressState(item.runtime)).toBe("delivery_unknown");
    expect(
      item.runtime.database.db
        .prepare<[], { status: string }>(
          "SELECT status FROM jobs WHERE type = 'egress_reconcile'",
        )
        .get()?.status,
    ).toBe("succeeded");
  });

  it("resumes memory and reply planning after a completed-run crash gap", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway);
    gateway.inbox.push(inboundMessage("msg_gap"));

    await sweep(item);
    const job = requiredJob(item.runtime.queue.claim(Date.now() + 10));
    const inbound = item.runtime.database.db
      .prepare<[], { id: string; trace_id: string }>("SELECT id, trace_id FROM inbound_messages")
      .get();
    if (inbound === undefined) {
      throw new Error("Expected crash-gap inbound");
    }
    const runs = new AgentRunStore(item.runtime.database.db, item.runtime.traces);
    const run = runs.startOrResume({
      inboundId: asInboundId(inbound.id),
      traceId: asTraceId(inbound.trace_id),
      deadlineAtMs: Date.now() + 60_000,
    });
    runs.appendInitialMessages(run.id, [{ role: "user", content: "Hello" }]);
    runs.complete(run.id, "Recovered reply.");

    const context: JobContext = {
      signal: new AbortController().signal,
      assertLease: () => item.runtime.queue.assertLease(job),
    };
    await item.runtime.handlers.inbound(job, context);
    item.runtime.queue.complete(job);

    expect(model.requests).toHaveLength(0);
    expect(model.maintenanceRequests).toHaveLength(1);
    expect(
      item.runtime.database.db
        .prepare<[], { body: string; state: string }>(
          "SELECT body, state FROM egress_messages WHERE purpose = 'reply'",
        )
        .get(),
    ).toEqual({ body: "Recovered reply.", state: "prepared" });
  });

  it("recovers the ingress cursor and accepted work after a process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "imessage-runtime-restart-"));
    const config = runtimeConfig(directory);
    const beforeCrash = new FakeGateway();
    const first = await createRuntime(config, {
      model: new FakeModel(),
      messageGateway: beforeCrash,
      logger: false,
    });
    await first.app.ready();
    const survivor = inboundMessage("msg_before_restart");
    beforeCrash.inbox.push(survivor);
    await first.receiver.sweepOnce(new AbortController().signal);
    expect(count(first, "inbound_messages")).toBe(1);
    expect(count(first, "agent_runs")).toBe(0);
    await first.close();

    const model = new FakeModel();
    const afterCrash = new FakeGateway();
    afterCrash.inbox.push(survivor, inboundMessage("msg_after_restart", { text: "Second" }));
    const second = await createRuntime(config, {
      model,
      messageGateway: afterCrash,
      logger: false,
    });
    tracked.push({ runtime: second, directory });

    await second.receiver.sweepOnce(new AbortController().signal);

    // The restarted receiver re-lists the survivor from the durable cursor and
    // only the unseen message becomes new durable work.
    expect(afterCrash.listCalls[0]?.updatedAtGteMs).toBeLessThan(survivor.updatedAtMs);
    expect(
      second.database.db
        .prepare<[], { guid: string }>("SELECT guid FROM inbound_messages ORDER BY sequence")
        .all()
        .map((row) => row.guid),
    ).toEqual(["msg_before_restart", "msg_after_restart"]);

    await runNextJob(second, Date.now() + 10);
    await runNextJob(second, Date.now() + 20);

    expect(model.requests).toHaveLength(2);
    expect(count(second, "agent_runs")).toBe(2);
    expect(
      second.database.db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM inbound_messages WHERE state = 'done'",
        )
        .get()?.count,
    ).toBe(2);
  });

  it("ingests a message the wake stream announces and stops on shutdown", async () => {
    const gateway = new FakeGateway();
    const item = await newRuntime(new FakeModel(), gateway);
    const controller = new AbortController();
    const startupSweep = gateway.nextList();
    const running = item.runtime.receiver.run(controller.signal);

    await startupSweep;
    expect(gateway.streamOpens).toBe(1);
    expect(count(item.runtime, "inbound_messages")).toBe(0);

    const wakeSweep = gateway.nextList();
    gateway.inbox.push(inboundMessage("msg_wake"));
    const wokeAtMs = Date.now();
    gateway.emitWake();
    await wakeSweep;
    const wakeLatencyMs = Date.now() - wokeAtMs;

    controller.abort();
    await running;

    // The receiver also sweeps on a five-second fallback interval, so landing
    // far inside it is what proves the stream event drove this sweep.
    expect(wakeLatencyMs).toBeLessThan(2_500);
    expect(count(item.runtime, "inbound_messages")).toBe(1);
    expect(count(item.runtime, "jobs")).toBe(1);
  });
});

async function newRuntime(model: FakeModel, gateway: FakeGateway): Promise<TrackedRuntime> {
  const directory = mkdtempSync(join(tmpdir(), "imessage-runtime-test-"));
  const runtime = await createRuntime(runtimeConfig(directory), {
    model,
    messageGateway: gateway,
    logger: false,
  });
  await runtime.app.ready();
  const item = { runtime, directory };
  tracked.push(item);
  return item;
}

function runtimeConfig(directory: string): RuntimeConfig {
  return loadRuntimeConfig({
    NODE_ENV: "test",
    DATA_DIR: directory,
    SENDBLUE_API_KEY_ID: "sendblue_test_key_id",
    SENDBLUE_API_SECRET_KEY: "sendblue_test_secret_key",
    SENDBLUE_FROM_NUMBER: lineNumber,
    SENDBLUE_BASE_URL: "https://api.sendblue.example",
    USER_PHONE_NUMBER: userNumber,
    PUBLIC_BASE_URL: "https://assistant.example",
    DEEPSEEK_API_KEY: "deepseek_test_key",
    GOOGLE_CLIENT_ID: "google_test_client",
    GOOGLE_CLIENT_SECRET: "google_test_secret",
    GOOGLE_WORKSPACE_SCOPES: "openid email https://www.googleapis.com/auth/gmail.modify",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    JOB_LEASE_MS: "10000",
  });
}

async function sweep(item: TrackedRuntime): Promise<void> {
  await item.runtime.receiver.sweepOnce(new AbortController().signal);
}

let inboundSequence = 0;

function inboundMessage(
  id: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  inboundSequence += 1;
  const timestamp = Date.now() + inboundSequence;
  return {
    id,
    senderNumber: userNumber,
    contactNumber: userNumber,
    lineNumber,
    recipientNumber: lineNumber,
    text: "Hello",
    hasMedia: false,
    isOutbound: false,
    messageType: "message",
    groupId: null,
    service: "iMessage",
    status: "RECEIVED",
    sentAtMs: timestamp,
    updatedAtMs: timestamp,
    replyToId: null,
    ...overrides,
  };
}

async function runNextJob(runtime: AssistantRuntime, nowMs: number): Promise<void> {
  const job = requiredJob(runtime.queue.claim(nowMs));
  const context: JobContext = {
    signal: new AbortController().signal,
    assertLease: () => runtime.queue.assertLease(job),
  };
  await runtime.handlers[job.type](job, context);
  runtime.queue.complete(job);
  runtime.projector.project(job.traceId);
}

function requiredJob(job: ClaimedJob | undefined): ClaimedJob {
  if (job === undefined) {
    throw new Error("Expected a durable job");
  }
  return job;
}

function acceptedTraceId(runtime: AssistantRuntime): TraceId {
  const row = runtime.database.db
    .prepare<[], { trace_id: string }>("SELECT trace_id FROM inbound_messages")
    .get();
  if (row === undefined) {
    throw new Error("Expected an accepted inbound trace");
  }
  return asTraceId(row.trace_id);
}

function inboundState(runtime: AssistantRuntime): string | undefined {
  return runtime.database.db
    .prepare<[], { state: string }>("SELECT state FROM inbound_messages")
    .get()?.state;
}

function egressState(runtime: AssistantRuntime): string | undefined {
  return runtime.database.db
    .prepare<[], { state: string }>("SELECT state FROM egress_messages")
    .get()?.state;
}

function runnableJobs(runtime: AssistantRuntime, type: JobType): number {
  return (
    runtime.database.db
      .prepare<{ type: JobType }, { count: number }>(
        `SELECT COUNT(*) AS count FROM jobs
         WHERE type = @type AND status IN ('pending', 'running')`,
      )
      .get({ type })?.count ?? 0
  );
}

function count(
  runtime: AssistantRuntime,
  table: "inbound_messages" | "jobs" | "agent_runs",
): number {
  return (
    runtime.database.db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0
  );
}
