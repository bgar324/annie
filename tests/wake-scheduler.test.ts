import { afterEach, describe, expect, it } from "vitest";
import { newEgressId, newRunId, newTraceId } from "../src/core/ids.js";
import type { DailyBriefScheduleResult } from "../src/messages/daily-brief.js";
import {
  WakeScheduler,
  type WakeDailyBriefSource,
  type WakeHintSource,
  type WakeQueueSource,
} from "../src/messages/wake-scheduler.js";
import { QueueStore } from "../src/queue/store.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const chatId = "+15559990000";
const lineNumber = "+15551112222";
const brokerSecret = "wake-secret-value";
const brokerUrl = "https://wake.example.workers.dev/schedule";
const minuteMs = 60_000;
const fallbackIntervalMs = 6 * 60 * 60 * 1_000;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

interface PublishAttempt {
  url: string;
  authorization: string | null;
  body: unknown;
}

interface SchedulerHarness {
  scheduler: WakeScheduler;
  traces: TraceStore;
  database: TestDatabase;
  attempts: PublishAttempt[];
  queueDeadline: { value: number | undefined };
  hintDeadline: { value: number | undefined };
  daily: { value: DailyBriefScheduleResult };
  respondWith(status: number): void;
  failWith(error: Error): void;
  traceRows(): { component: string; event: string; outcome: string | null; data: string }[];
}

function createSchedulerHarness(
  options: { brokerUrl?: string | undefined; secret?: string | undefined } = {},
): SchedulerHarness {
  const database = createTestDatabase();
  databases.push(database);
  const traces = new TraceStore(database.handle.db, createTraceRedactor([brokerSecret]));
  const attempts: PublishAttempt[] = [];
  const queueDeadline: { value: number | undefined } = { value: undefined };
  const hintDeadline: { value: number | undefined } = { value: undefined };
  const daily: { value: DailyBriefScheduleResult } = { value: { kind: "disabled" } };
  let status = 200;
  let failure: Error | undefined;

  const queue: WakeQueueSource = { nextWakeAt: () => queueDeadline.value };
  const receiver: WakeHintSource = { nextWakeAt: () => hintDeadline.value };
  const dailyBrief: WakeDailyBriefSource = { reconcile: () => daily.value };
  const fetchStub: typeof fetch = async (input, init) => {
    attempts.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as unknown,
    });
    if (failure !== undefined) {
      throw failure;
    }
    return new Response("{}", { status, headers: { "content-type": "application/json" } });
  };

  const scheduler = new WakeScheduler({
    queue,
    receiver,
    dailyBrief,
    traces,
    brokerUrl: "brokerUrl" in options ? options.brokerUrl : brokerUrl,
    secret: "secret" in options ? options.secret : brokerSecret,
    fetch: fetchStub,
  });

  return {
    scheduler,
    traces,
    database,
    attempts,
    queueDeadline,
    hintDeadline,
    daily,
    respondWith(next: number): void {
      status = next;
      failure = undefined;
    },
    failWith(error: Error): void {
      failure = error;
    },
    traceRows(): { component: string; event: string; outcome: string | null; data: string }[] {
      return database.handle.db
        .prepare<[], { component: string; event: string; outcome: string | null; data: string }>(`
          SELECT component, event, outcome, redacted_json AS data
          FROM trace_event_spool
          ORDER BY occurred_at_ms, sequence
        `)
        .all();
    },
  };
}

function createQueue(leaseMs = 60_000): { queue: QueueStore; database: TestDatabase } {
  const database = createTestDatabase();
  databases.push(database);
  const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
  return {
    database,
    queue: new QueueStore({ db: database.handle.db, traces, leaseMs, maxPending: 32 }),
  };
}

describe("queue wake deadlines", () => {
  it("reports nothing to wake for when the queue is empty", () => {
    const { queue } = createQueue();

    expect(queue.nextWakeAt(Date.now())).toBeUndefined();
  });

  it("reports a scheduled job at its availability and an overdue one immediately", () => {
    const { queue } = createQueue();
    const now = Date.now();
    queue.enqueue({
      chatId,
      type: "daily_brief",
      subjectId: "2026-09-24",
      payload: {},
      traceId: newTraceId(),
      availableAtMs: now + 9 * 60 * minuteMs,
    });

    expect(queue.nextWakeAt(now)).toBe(now + 9 * 60 * minuteMs);

    queue.enqueue({
      chatId: "chat_other",
      type: "egress_send",
      subjectId: newEgressId(),
      payload: {},
      traceId: newTraceId(),
      availableAtMs: now - 5_000,
    });

    expect(queue.nextWakeAt(now)).toBe(now);
  });

  it("waits for a running lease to expire instead of a job it blocks", () => {
    const { queue } = createQueue();
    const now = Date.now();
    queue.enqueue({
      chatId,
      type: "inbound",
      subjectId: "in_running",
      payload: {},
      traceId: newTraceId(),
      availableAtMs: now,
      inboundSequence: 1,
    });
    expect(queue.claim(now)?.subjectId).toBe("in_running");
    queue.enqueue({
      chatId,
      type: "egress_send",
      subjectId: "eg_blocked",
      payload: {},
      traceId: newTraceId(),
      availableAtMs: now + 1_000,
    });

    expect(queue.nextWakeAt(now)).toBe(now + 60_000);
  });

  it("waits for the earlier inbound rather than the job queued behind it", () => {
    const { queue } = createQueue();
    const now = Date.now();
    queue.enqueue({
      chatId,
      type: "inbound",
      subjectId: "in_first",
      payload: {},
      traceId: newTraceId(),
      availableAtMs: now + 60_000,
      inboundSequence: 1,
    });
    queue.enqueue({
      chatId,
      type: "inbound",
      subjectId: "in_second",
      payload: {},
      traceId: newTraceId(),
      availableAtMs: now + 10_000,
      inboundSequence: 2,
    });

    expect(queue.nextWakeAt(now)).toBe(now + 60_000);
  });

  it("never pins the schedule to a memory job that is waiting on a delivery receipt", () => {
    const { queue, database } = createQueue();
    const now = Date.now();
    const runId = newRunId();
    const traceId = newTraceId();
    const memoryJobId = queue.enqueue({
      chatId,
      type: "memory_maintenance",
      subjectId: runId,
      payload: { runId },
      traceId,
      availableAtMs: now - 30_000,
      runId,
    });
    database.handle.db
      .prepare(`
        INSERT INTO agent_runs(
          id, inbound_id, scheduled_job_id, trace_id, phase, model_requests,
          maintenance_requests, tool_calls, provider_writes, deadline_at_ms,
          transcript_bytes, memory_maintenance_status, created_at_ms, updated_at_ms
        ) VALUES (?, NULL, ?, ?, 'completed', 1, 0, 0, 0, ?, 10, 'pending', ?, ?)
      `)
      .run(runId, memoryJobId, traceId, now + 60_000, now, now);
    const egressId = newEgressId();
    database.handle.db
      .prepare(`
        INSERT INTO egress_messages(
          id, run_id, trace_id, recipient_handle, line_handle, body, purpose, state,
          attempt_count, poll_count, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'Awaiting receipt.', 'reply', 'sent', 1, 0, ?, ?)
      `)
      .run(egressId, runId, traceId, chatId, lineNumber, now, now);
    const reconcileId = queue.enqueue({
      chatId,
      type: "egress_reconcile",
      subjectId: egressId,
      payload: {},
      traceId,
      availableAtMs: now + 120_000,
      runId,
    });
    expect(reconcileId).toBeDefined();

    // The overdue memory job cannot run until the receipt lands, so the receipt poll is the
    // only deadline worth waking for.
    expect(queue.nextWakeAt(now)).toBe(now + 120_000);

    const receipt = queue.claim(now + 120_000);
    expect(receipt?.type).toBe("egress_reconcile");
    if (receipt === undefined) {
      throw new Error("the receipt job was not claimable");
    }
    queue.complete(receipt);

    expect(queue.nextWakeAt(now + 120_000)).toBe(now + 120_000);
  });
});

describe("wake scheduler", () => {
  it("publishes the earliest deadline once and stays quiet until it moves", async () => {
    const harness = createSchedulerHarness();
    const now = Date.now();
    const signal = new AbortController().signal;
    harness.queueDeadline.value = now + 10 * minuteMs;

    await harness.scheduler.tick(signal, now);

    expect(harness.attempts).toEqual([
      {
        url: brokerUrl,
        authorization: `Bearer ${brokerSecret}`,
        body: { nextWakeAt: now + 10 * minuteMs },
      },
    ]);
    expect(harness.scheduler.publishedWakeAt).toBe(now + 10 * minuteMs);

    await harness.scheduler.tick(signal, now + 1_000);
    expect(harness.attempts).toHaveLength(1);

    // A lease heartbeat pushing the deadline a minute later is not worth a request.
    harness.queueDeadline.value = now + 11 * minuteMs;
    await harness.scheduler.tick(signal, now + 2_000);
    expect(harness.attempts).toHaveLength(1);

    // Work that lands sooner than the broker knows about is.
    harness.queueDeadline.value = now + 4 * minuteMs;
    await harness.scheduler.tick(signal, now + 3_000);
    expect(harness.attempts).toHaveLength(2);
    expect(harness.attempts[1]?.body).toEqual({ nextWakeAt: now + 4 * minuteMs });
  });

  it("falls back to a stable six-hour boundary and prefers a deferred brief", async () => {
    const harness = createSchedulerHarness();
    // Fixed so the six-hour boundary can never land inside the next-minute floor.
    const now = Date.UTC(2026, 8, 23, 14, 32, 10);
    const signal = new AbortController().signal;
    const fallbackAtMs = Math.floor(now / fallbackIntervalMs) * fallbackIntervalMs + fallbackIntervalMs;

    expect(harness.scheduler.desiredWakeAt(now)).toBe(fallbackAtMs);

    harness.daily.value = {
      kind: "deferred",
      localDate: "2026-09-24",
      scheduledForMs: now + 3 * 60 * minuteMs,
    };
    await harness.scheduler.tick(signal, now);

    expect(harness.attempts.map((attempt) => attempt.body)).toEqual([
      { nextWakeAt: now + 3 * 60 * minuteMs },
    ]);
  });

  it("never asks for a wake sooner than the next whole minute", async () => {
    const harness = createSchedulerHarness();
    const now = Math.floor(Date.now() / minuteMs) * minuteMs + 12_000;
    const signal = new AbortController().signal;
    harness.hintDeadline.value = now - 5_000;

    await harness.scheduler.tick(signal, now);
    await harness.scheduler.tick(signal, now + 5_000);

    const nextMinuteAtMs = Math.floor(now / minuteMs) * minuteMs + minuteMs;
    expect(harness.attempts.map((attempt) => attempt.body)).toEqual([
      { nextWakeAt: nextMinuteAtMs },
    ]);
  });

  it("records the attempt before the request and only trusts an acknowledged schedule", async () => {
    const harness = createSchedulerHarness();
    const now = Date.now();
    const signal = new AbortController().signal;
    harness.queueDeadline.value = now + 30 * minuteMs;
    harness.respondWith(502);

    await harness.scheduler.tick(signal, now);

    expect(harness.attempts).toHaveLength(1);
    expect(harness.scheduler.publishedWakeAt).toBeUndefined();
    expect(harness.traceRows().map((row) => row.event)).toEqual([
      "publish_attempt",
      "publish_failed",
    ]);

    // The failure backs off instead of hammering an unreachable broker.
    await harness.scheduler.tick(signal, now + 5_000);
    expect(harness.attempts).toHaveLength(1);

    harness.respondWith(200);
    await harness.scheduler.tick(signal, now + 20_000);

    expect(harness.attempts).toHaveLength(2);
    expect(harness.scheduler.publishedWakeAt).toBe(now + 30 * minuteMs);
    expect(harness.traceRows().map((row) => row.event)).toEqual([
      "publish_attempt",
      "publish_failed",
      "publish_attempt",
      "published",
    ]);
  });

  it("retries a broker that cannot be reached at all", async () => {
    const harness = createSchedulerHarness();
    const now = Date.now();
    const signal = new AbortController().signal;
    harness.queueDeadline.value = now + 30 * minuteMs;
    harness.failWith(new TypeError("fetch failed"));

    await harness.scheduler.tick(signal, now);
    expect(harness.scheduler.publishedWakeAt).toBeUndefined();

    harness.respondWith(200);
    await harness.scheduler.tick(signal, now + 20_000);

    expect(harness.attempts).toHaveLength(2);
    expect(harness.scheduler.publishedWakeAt).toBe(now + 30 * minuteMs);
  });

  it("keeps the shared secret out of every trace it writes", async () => {
    const harness = createSchedulerHarness();
    const now = Date.now();
    const signal = new AbortController().signal;
    harness.queueDeadline.value = now + minuteMs * 30;
    harness.respondWith(401);
    await harness.scheduler.tick(signal, now);
    harness.respondWith(200);
    await harness.scheduler.tick(signal, now + 30_000);

    const rows = harness.traceRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(`${row.event}${row.outcome ?? ""}${row.data}`).not.toContain(brokerSecret);
    }
  });

  it("makes one last attempt at shutdown rather than abandoning an unpublished deadline", async () => {
    const harness = createSchedulerHarness();
    harness.queueDeadline.value = Date.now() + 45 * minuteMs;
    harness.respondWith(503);
    const controller = new AbortController();

    const running = harness.scheduler.run(controller.signal);
    controller.abort();
    await running;

    // The first pass failed and armed a backoff that outlives the loop; shutdown ignores it.
    expect(harness.attempts).toHaveLength(2);
    expect(harness.scheduler.publishedWakeAt).toBeUndefined();
  });


  it("does nothing at all without a broker url or secret", async () => {
    const withoutUrl = createSchedulerHarness({ brokerUrl: undefined });
    const withoutSecret = createSchedulerHarness({ secret: undefined });
    const controller = new AbortController();

    expect(withoutUrl.scheduler.enabled).toBe(false);
    expect(withoutSecret.scheduler.enabled).toBe(false);

    await withoutUrl.scheduler.run(controller.signal);
    await withoutSecret.scheduler.run(controller.signal);
    await withoutUrl.scheduler.tick(controller.signal, Date.now());

    expect(withoutUrl.attempts).toEqual([]);
    expect(withoutSecret.attempts).toEqual([]);
    expect(withoutUrl.traceRows()).toEqual([]);
  });

  it("publishes on the first pass of the loop and stops when aborted", async () => {
    const harness = createSchedulerHarness();
    harness.queueDeadline.value = Date.now() + 45 * minuteMs;
    const controller = new AbortController();

    const running = harness.scheduler.run(controller.signal);
    controller.abort();
    await running;

    expect(harness.attempts).toHaveLength(1);
  });
});
