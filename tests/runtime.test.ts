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
import { ConnectionStore } from "../src/connections/store.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  asInboundId,
  asTraceId,
  newTraceId,
  type ConnectionId,
  type TraceId,
} from "../src/core/ids.js";
import type { GmailApi, GmailClientProvider } from "../src/gmail/client.js";
import type { NotionClientProvider, NotionSession } from "../src/notion/client.js";
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
import { CredentialVault } from "../src/security/vault.js";

const lineNumber = "+15551112222";
const userNumber = "+15559990000";
const foreignNumber = "+15550000000";

interface TrackedRuntime {
  runtime: AssistantRuntime;
  directory: string;
  config: RuntimeConfig;
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
  readonly responses: ModelResponse[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return (
      this.responses.shift() ?? {
        id: "response_1",
        content: "Hello back.",
        providerState: null,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      }
    );
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

class FakeGmailClients implements GmailClientProvider {
  readonly selected: ConnectionId[] = [];
  readonly searches: { query: string; maxResults: number }[] = [];

  async forConnection(connectionId: ConnectionId): Promise<GmailApi> {
    this.selected.push(connectionId);
    return {
      listMessages: async (input) => {
        this.searches.push({ query: input.query, maxResults: input.maxResults });
        return { data: { messages: [], resultSizeEstimate: 0 }, headers: {} };
      },
      getMessage: async () => {
        throw new Error("Daily brief should not read an absent Gmail message");
      },
      getThread: async () => {
        throw new Error("Daily brief should not read an absent Gmail thread");
      },
      createDraft: async () => {
        throw new Error("Daily brief cannot create a Gmail draft");
      },
      sendDraft: async () => {
        throw new Error("Daily brief cannot send a Gmail draft");
      },
    };
  }
}

class FakeNotionClients implements NotionClientProvider {
  readonly selected: ConnectionId[] = [];
  readonly searches: Record<string, unknown>[] = [];

  async withSession<T>(
    connectionId: ConnectionId,
    _traceId: TraceId,
    operation: (session: NotionSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    this.selected.push(connectionId);
    const session: NotionSession = {
      validate: () => undefined,
      call: async (name, argumentsValue) => {
        if (name !== "notion-search") {
          throw new Error(`Daily brief made an unexpected Notion call: ${name}`);
        }
        this.searches.push(argumentsValue);
        return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
      },
    };
    return operation(session);
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
    const systemPrompt = model.requests[0]?.messages.find(
      (message) => message.role === "system",
    )?.content;
    expect(systemPrompt).toContain(
      "You are Ben, the user's private personal assistant in iMessage.",
    );
    expect(systemPrompt).toContain(
      "Write normal prose in lowercase. Preserve case in URLs, email addresses, identifiers, quoted text, and exact provider content.",
    );
    expect(systemPrompt).toContain(
      "Keep the tone casual. Be concise and direct, but include the details the user needs to understand or act.",
    );
    expect(systemPrompt).toContain(
      "Connection commands are handled by infrastructure before the model: `connect google` or `connect gmail`, `connect notion`, and `connections`.",
    );
    expect(systemPrompt).toContain(
      "When multiple exist, never choose one arbitrarily",
    );
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

  it("durably schedules one local eight-AM job across daylight-saving offsets", async () => {
    const item = await newRuntime(new FakeModel(), new FakeGateway(), {
      dailyBriefEnabled: true,
    });
    const springNow = Date.parse("2026-03-08T14:00:00.000Z");
    const spring = item.runtime.dailyBrief.reconcile(springNow);
    const duplicate = item.runtime.dailyBrief.reconcile(springNow + 30 * 60 * 1_000);
    const fall = item.runtime.dailyBrief.reconcile(Date.parse("2026-11-01T15:00:00.000Z"));

    expect(spring).toMatchObject({
      kind: "scheduled",
      localDate: "2026-03-08",
      scheduledForMs: Date.parse("2026-03-08T15:00:00.000Z"),
    });
    expect(duplicate).toMatchObject({
      kind: "existing",
      jobId: spring.kind === "scheduled" ? spring.jobId : undefined,
    });
    expect(fall).toMatchObject({
      kind: "scheduled",
      localDate: "2026-11-01",
      scheduledForMs: Date.parse("2026-11-01T16:00:00.000Z"),
    });
    expect(runnableJobs(item.runtime, "daily_brief")).toBe(2);
  });

  it("plans trace-addressable setup guidance and expires it before a stale send", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway, {
      dailyBriefEnabled: true,
    });
    const scheduled = item.runtime.dailyBrief.reconcile(
      Date.parse("2026-06-01T14:00:00.000Z"),
    );
    if (scheduled.kind !== "scheduled") {
      throw new Error(`Expected a scheduled daily brief, received ${scheduled.kind}`);
    }

    await runNextJob(item.runtime, scheduled.scheduledForMs + 1);

    expect(model.requests).toHaveLength(0);
    expect(model.maintenanceRequests).toHaveLength(0);
    expect(
      item.runtime.database.db
        .prepare<[], { body: string; purpose: string; reply_to_guid: string | null }>(
          "SELECT body, purpose, reply_to_guid FROM egress_messages",
        )
        .get(),
    ).toEqual({
      body: `good morning — i can’t build your daily brief until an account is connected. send ‘connect google’ for gmail or ‘connect notion’, then send ‘connections’ to verify it. trace: ${scheduled.traceId}`,
      purpose: "reply",
      reply_to_guid: null,
    });
    expect(count(item.runtime, "agent_runs")).toBe(0);
    await runNextJob(
      item.runtime,
      Math.max(Date.now() + 1_000, scheduled.scheduledForMs + 2 * 60 * 60 * 1_000),
    );
    expect(gateway.sends).toEqual([]);
    expect(
      item.runtime.database.db
        .prepare<[], { state: string; last_error: string | null }>(
          "SELECT state, last_error FROM egress_messages",
        )
        .get(),
    ).toEqual({
      state: "provider_failed",
      last_error: "daily_brief_expired",
    });
    expect(
      item.runtime.database.db
        .prepare<[], { state: string }>("SELECT state FROM write_intents")
        .get(),
    ).toEqual({ state: "confirmed_failed" });
  });

  it("cancels a prepared daily message when the feature is disabled", async () => {
    const gateway = new FakeGateway();
    const item = await newRuntime(new FakeModel(), gateway, {
      dailyBriefEnabled: true,
    });
    const scheduled = item.runtime.dailyBrief.reconcile(
      Date.parse("2026-06-04T14:00:00.000Z"),
    );
    if (scheduled.kind !== "scheduled") {
      throw new Error(`Expected a scheduled daily brief, received ${scheduled.kind}`);
    }
    await runNextJob(item.runtime, scheduled.scheduledForMs + 1);

    item.config.dailyBrief.enabled = false;
    await runNextJob(item.runtime, Date.now() + 1_000);

    expect(gateway.sends).toEqual([]);
    expect(
      item.runtime.database.db
        .prepare<[], { state: string; last_error: string | null }>(
          "SELECT state, last_error FROM egress_messages",
        )
        .get(),
    ).toEqual({
      state: "provider_failed",
      last_error: "daily_brief_disabled",
    });
  });

  it("skips a persisted brief after the same-morning catch-up window", async () => {
    const model = new FakeModel();
    const item = await newRuntime(model, new FakeGateway(), {
      dailyBriefEnabled: true,
    });
    const scheduled = item.runtime.dailyBrief.reconcile(
      Date.parse("2026-06-05T14:00:00.000Z"),
    );
    if (scheduled.kind !== "scheduled") {
      throw new Error(`Expected a scheduled daily brief, received ${scheduled.kind}`);
    }

    await runNextJob(
      item.runtime,
      scheduled.scheduledForMs + 2 * 60 * 60 * 1_000,
    );

    expect(model.requests).toHaveLength(0);
    expect(
      item.runtime.database.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM egress_messages")
        .get()?.count,
    ).toBe(0);
    expect(
      item.runtime.traces
        .list(scheduled.traceId)
        .some(
          (event) =>
            event.component === "daily_brief" &&
            event.event === "skipped" &&
            event.outcome === "stale",
        ),
    ).toBe(true);
    expect(
      item.runtime.database.db
        .prepare<{ trace_id: string }, { state: string }>(
          "SELECT state FROM trace_streams WHERE trace_id = @trace_id",
        )
        .get({ trace_id: scheduled.traceId })?.state,
    ).toBe("exported");
  });

  it("recovers an exhausted daily job with one terminal run and failure notice", async () => {
    const item = await newRuntime(new FakeModel(), new FakeGateway(), {
      dailyBriefEnabled: true,
    });
    const scheduled = item.runtime.dailyBrief.reconcile(
      Date.parse("2026-06-07T14:00:00.000Z"),
    );
    if (scheduled.kind !== "scheduled") {
      throw new Error(`Expected a scheduled daily brief, received ${scheduled.kind}`);
    }
    const job = requiredJob(item.runtime.queue.claim(scheduled.scheduledForMs + 1));
    const runId = "run_exhausted_daily";
    item.runtime.database.db
      .prepare<{
        id: string;
        scheduled_job_id: string;
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
          @id, NULL, @scheduled_job_id, @trace_id, 'running', 0,
          0, 0, 0, @deadline_at_ms, 0, 'pending', NULL, NULL, NULL, NULL, NULL,
          @now_ms, @now_ms
        )
      `)
      .run({
        id: runId,
        scheduled_job_id: job.id,
        trace_id: job.traceId,
        deadline_at_ms: scheduled.scheduledForMs + 60_000,
        now_ms: scheduled.scheduledForMs,
      });
    item.runtime.database.db
      .prepare<{
        id: string;
        run_id: string;
        lease_expires_at_ms: number;
      }>(`
        UPDATE jobs
        SET run_id = @run_id, attempts = 5, lease_expires_at_ms = @lease_expires_at_ms
        WHERE id = @id
      `)
      .run({
        id: job.id,
        run_id: runId,
        lease_expires_at_ms: scheduled.scheduledForMs,
      });

    expect(item.runtime.queue.claim(scheduled.scheduledForMs + 60_000)).toBeUndefined();
    item.runtime.dailyBrief.reconcile(scheduled.scheduledForMs + 60_000);

    expect(
      item.runtime.database.db
        .prepare<{ id: string }, { status: string }>(
          "SELECT status FROM jobs WHERE id = @id",
        )
        .get({ id: job.id }),
    ).toEqual({ status: "failed" });
    expect(
      item.runtime.database.db
        .prepare<{ id: string }, { phase: string; failure_code: string | null }>(
          "SELECT phase, failure_code FROM agent_runs WHERE id = @id",
        )
        .get({ id: runId }),
    ).toEqual({
      phase: "failed",
      failure_code: "daily_brief_job_failed",
    });
    expect(
      item.runtime.database.db
        .prepare<[], { purpose: string; body: string }>(
          "SELECT purpose, body FROM egress_messages",
        )
        .get(),
    ).toEqual({
      purpose: "failure",
      body: `I couldn't complete that request. Trace: ${scheduled.traceId}`,
    });
  });

  it("covers every healthy account through the scheduled read-only tool allowlist", async () => {
    const model = new FakeModel();
    model.responses.push(
      {
        id: "brief_tools",
        content: "",
        providerState: null,
        toolCalls: [
          {
            id: "gmail_one",
            name: "gmail.search",
            argumentsJson: JSON.stringify({
              query: "is:unread newer_than:1d",
              account: "one@example.test",
              maxResults: 5,
            }),
          },
          {
            id: "gmail_two",
            name: "gmail.search",
            argumentsJson: JSON.stringify({
              query: "is:unread newer_than:1d",
              account: "two@example.test",
              maxResults: 5,
            }),
          },
          {
            id: "gmail_three",
            name: "gmail.search",
            argumentsJson: JSON.stringify({
              query: "is:unread newer_than:1d",
              account: "three@example.test",
              maxResults: 5,
            }),
          },
          {
            id: "notion_work",
            name: "notion.search",
            argumentsJson: JSON.stringify({
              query: "today",
              workspace: "Work",
              pageSize: 5,
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
      {
        id: "brief_final",
        content: "good morning. nothing urgent across your connected accounts.",
        providerState: null,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 },
      },
    );
    const gmailClients = new FakeGmailClients();
    const notionClients = new FakeNotionClients();
    const item = await newRuntime(model, new FakeGateway(), {
      dailyBriefEnabled: true,
      gmailClients,
      notionClients,
    });
    const connections = new ConnectionStore(
      item.runtime.database.db,
      new CredentialVault(item.config.credentialEncryptionKey),
      item.runtime.traces,
    );
    const googleConnections = ["one@example.test", "two@example.test", "three@example.test"].map(
      (label, index) =>
        connections.saveAuthorization({
          traceId: newTraceId(),
          provider: "google",
          providerAccountId: `google_sub_${index + 1}`,
          safeLabel: label,
          safeMetadata: { email: label },
          providerState: { scopes: item.config.google.scopes },
          capabilities: ["gmail.search", "gmail.read_thread"],
          credentials: { refreshToken: `refresh_${index + 1}` },
        }),
    );
    const notionConnection = connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "notion",
      providerAccountId: "workspace_work",
      safeLabel: "Work",
      safeMetadata: { workspaceName: "Work" },
      providerState: { scopes: ["user", "workspace"] },
      capabilities: ["notion.search", "notion.fetch"],
      credentials: { accessToken: "notion_access" },
    });
    const scheduled = item.runtime.dailyBrief.reconcile(
      Date.parse("2026-06-02T14:00:00.000Z"),
    );
    if (scheduled.kind !== "scheduled") {
      throw new Error(`Expected a scheduled daily brief, received ${scheduled.kind}`);
    }

    await runNextJob(item.runtime, scheduled.scheduledForMs + 1);

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "gmail.search",
      "gmail.read_thread",
      "notion.search",
      "notion.fetch",
    ]);
    const briefRequest = model.requests[0]?.messages.find(
      (message) => message.role === "user",
    )?.content;
    for (const label of ["one@example.test", "two@example.test", "three@example.test", "Work"]) {
      expect(briefRequest).toContain(label);
    }
    expect(gmailClients.selected).toEqual(googleConnections.map((connection) => connection.id));
    expect(notionClients.selected).toEqual([notionConnection.id]);
    expect(gmailClients.searches).toHaveLength(3);
    expect(notionClients.searches).toEqual([
      { query: "today", query_type: "internal", page_size: 5 },
    ]);
    expect(model.maintenanceRequests).toHaveLength(1);
    expect(
      item.runtime.database.db
        .prepare<[], { inbound_id: string | null; scheduled_job_id: string | null }>(
          "SELECT inbound_id, scheduled_job_id FROM agent_runs",
        )
        .get(),
    ).toEqual({ inbound_id: null, scheduled_job_id: scheduled.jobId });
    expect(
      item.runtime.database.db
        .prepare<[], { body: string }>("SELECT body FROM egress_messages WHERE purpose = 'reply'")
        .get(),
    ).toEqual({ body: "good morning. nothing urgent across your connected accounts." });
    expect(
      item.runtime.database.db
        .prepare<[], { kind: string }>("SELECT kind FROM write_intents")
        .all(),
    ).toEqual([{ kind: "sendblue_send_message" }]);
    const egressJobPayload = item.runtime.database.db
      .prepare<[], { payload_json: string }>(
        "SELECT payload_json FROM jobs WHERE type = 'egress_send'",
      )
      .get()?.payload_json;
    expect(egressJobPayload).toBeDefined();
    expect(JSON.parse(egressJobPayload ?? "{}")).toMatchObject({
      sendPolicy: {
        kind: "daily_brief",
        expiresAtMs: expect.any(Number),
      },
    });
  });

  it("fails closed when a completed-looking brief omits a healthy source", async () => {
    const model = new FakeModel();
    model.responses.push(
      {
        id: "partial_brief_tools",
        content: "",
        providerState: null,
        toolCalls: [
          {
            id: "partial_gmail",
            name: "gmail.search",
            argumentsJson: JSON.stringify({
              query: "is:unread newer_than:1d",
              account: "one@example.test",
              maxResults: 5,
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        id: "partial_brief_final",
        content: "everything is quiet.",
        providerState: null,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
      },
    );
    const gmailClients = new FakeGmailClients();
    const notionClients = new FakeNotionClients();
    const item = await newRuntime(model, new FakeGateway(), {
      dailyBriefEnabled: true,
      gmailClients,
      notionClients,
    });
    const connections = new ConnectionStore(
      item.runtime.database.db,
      new CredentialVault(item.config.credentialEncryptionKey),
      item.runtime.traces,
    );
    const google = connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "google_partial",
      safeLabel: "one@example.test",
      safeMetadata: { email: "one@example.test" },
      providerState: { scopes: item.config.google.scopes },
      capabilities: ["gmail.search", "gmail.read_thread"],
      credentials: { refreshToken: "refresh_partial" },
    });
    connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "notion",
      providerAccountId: "notion_partial",
      safeLabel: "Work",
      safeMetadata: { workspaceName: "Work" },
      providerState: { scopes: ["user", "workspace"] },
      capabilities: ["notion.search", "notion.fetch"],
      credentials: { accessToken: "notion_partial_access" },
    });
    const scheduled = item.runtime.dailyBrief.reconcile(
      Date.parse("2026-06-06T14:00:00.000Z"),
    );
    if (scheduled.kind !== "scheduled") {
      throw new Error(`Expected a scheduled daily brief, received ${scheduled.kind}`);
    }

    await runNextJob(item.runtime, scheduled.scheduledForMs + 1);

    expect(gmailClients.selected).toEqual([google.id]);
    expect(notionClients.selected).toEqual([]);
    expect(model.maintenanceRequests).toHaveLength(0);
    expect(
      item.runtime.database.db
        .prepare<[], { phase: string; failure_code: string | null }>(
          "SELECT phase, failure_code FROM agent_runs",
        )
        .get(),
    ).toEqual({
      phase: "blocked",
      failure_code: "daily_brief_source_coverage",
    });
    expect(
      item.runtime.database.db
        .prepare<[], { purpose: string; body: string }>(
          "SELECT purpose, body FROM egress_messages",
        )
        .get(),
    ).toEqual({
      purpose: "failure",
      body: `I couldn't complete that request. Trace: ${scheduled.traceId}`,
    });
  });

  it("rejects a scheduled provider write before creating a tool execution", async () => {
    const model = new FakeModel();
    model.responses.push({
      id: "brief_disallowed_write",
      content: "",
      providerState: null,
      toolCalls: [
        {
          id: "disallowed_send",
          name: "gmail.send_draft",
          argumentsJson: JSON.stringify({
            account: "one@example.test",
            draftId: "provider_draft",
          }),
        },
      ],
      finishReason: "tool_calls",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const item = await newRuntime(model, new FakeGateway(), {
      dailyBriefEnabled: true,
      gmailClients: new FakeGmailClients(),
    });
    const connections = new ConnectionStore(
      item.runtime.database.db,
      new CredentialVault(item.config.credentialEncryptionKey),
      item.runtime.traces,
    );
    connections.saveAuthorization({
      traceId: newTraceId(),
      provider: "google",
      providerAccountId: "google_disallowed",
      safeLabel: "one@example.test",
      safeMetadata: { email: "one@example.test" },
      providerState: { scopes: item.config.google.scopes },
      capabilities: [
        "gmail.search",
        "gmail.read_thread",
        "gmail.create_draft",
        "gmail.send_draft",
      ],
      credentials: { refreshToken: "refresh_disallowed" },
    });
    const scheduled = item.runtime.dailyBrief.reconcile(
      Date.parse("2026-06-03T14:00:00.000Z"),
    );
    if (scheduled.kind !== "scheduled") {
      throw new Error(`Expected a scheduled daily brief, received ${scheduled.kind}`);
    }

    await runNextJob(item.runtime, scheduled.scheduledForMs + 1);

    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "gmail.search",
      "gmail.read_thread",
      "notion.search",
      "notion.fetch",
    ]);
    expect(
      item.runtime.database.db
        .prepare<[], { failure_code: string }>("SELECT failure_code FROM agent_runs")
        .get(),
    ).toEqual({ failure_code: "tool_not_allowed" });
    expect(
      item.runtime.database.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM tool_executions")
        .get()?.count,
    ).toBe(0);
    expect(
      item.runtime.database.db
        .prepare<[], { purpose: string }>("SELECT purpose FROM egress_messages")
        .get(),
    ).toEqual({ purpose: "failure" });
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
    gateway.inbox.push(inboundMessage("msg_connect", { text: "connect my Gmail account" }));

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

  it("lists exact multi-account labels and capabilities without using the model", async () => {
    const model = new FakeModel();
    const gateway = new FakeGateway();
    const item = await newRuntime(model, gateway);
    const connections = new ConnectionStore(
      item.runtime.database.db,
      new CredentialVault(item.config.credentialEncryptionKey),
      item.runtime.traces,
    );
    for (const [index, label] of ["one@example.test", "two@example.test"].entries()) {
      connections.saveAuthorization({
        traceId: newTraceId(),
        provider: "google",
        providerAccountId: `google_status_${index + 1}`,
        safeLabel: label,
        safeMetadata: { email: label },
        providerState: { scopes: item.config.google.scopes },
        capabilities: ["gmail.search", "gmail.read_thread"],
        credentials: { refreshToken: `status_refresh_${index + 1}` },
      });
    }
    gateway.inbox.push(inboundMessage("msg_connections", { text: "connections" }));

    await sweep(item);
    await runNextJob(item.runtime, Date.now() + 10);

    const body = item.runtime.database.db
      .prepare<[], { body: string }>("SELECT body FROM egress_messages WHERE purpose = 'reply'")
      .get()?.body;
    expect(model.requests).toHaveLength(0);
    expect(body).toContain(
      "one@example.test: google, healthy; gmail.read_thread, gmail.search",
    );
    expect(body).toContain(
      "two@example.test: google, healthy; gmail.read_thread, gmail.search",
    );
    expect(body).toContain(
      "Use the exact label shown when more than one account can handle a request.",
    );
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
    const run = runs.startOrResume({ source: { kind: "inbound", inboundId: asInboundId(inbound.id) }, traceId: asTraceId(inbound.trace_id), deadlineAtMs: Date.now() + 60_000 });
    runs.appendInitialMessages(run.id, [{ role: "user", content: "Hello" }]);
    runs.complete(run.id, "Recovered reply.");

    const context: JobContext = {
      signal: new AbortController().signal,
      nowMs: () => Date.now(),
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
    tracked.push({ runtime: second, directory, config });

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

interface RuntimeTestOptions {
  dailyBriefEnabled?: boolean;
  gmailClients?: GmailClientProvider;
  notionClients?: NotionClientProvider;
}

async function newRuntime(
  model: FakeModel,
  gateway: FakeGateway,
  options: RuntimeTestOptions = {},
): Promise<TrackedRuntime> {
  const directory = mkdtempSync(join(tmpdir(), "imessage-runtime-test-"));
  const baseConfig = runtimeConfig(directory);
  const config = {
    ...baseConfig,
    dailyBrief: {
      ...baseConfig.dailyBrief,
      enabled: options.dailyBriefEnabled ?? baseConfig.dailyBrief.enabled,
    },
  };
  const runtime = await createRuntime(config, {
    model,
    messageGateway: gateway,
    ...(options.gmailClients === undefined ? {} : { gmailClients: options.gmailClients }),
    ...(options.notionClients === undefined ? {} : { notionClients: options.notionClients }),
    logger: false,
  });
  await runtime.app.ready();
  const item = { runtime, directory, config };
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
    GEMINI_API_KEY: "gemini_test_key",
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
    nowMs: () => nowMs,
    assertLease: () => runtime.queue.assertLease(job, nowMs),
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
