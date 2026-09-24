import { newTraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { DailyBriefScheduleResult } from "./daily-brief.js";

// One tick per half minute keeps the broker within a minute of the truth while the process is
// awake, and costs nothing once the schedule settles: ticks only reach the network when the
// deadline actually moves.
const tickIntervalMs = 30_000;
const minuteMs = 60_000;
// The broker can never be left with nothing to fire: a stable six-hour UTC boundary is the
// floor of every schedule, so a lost hint or a dropped publish still recovers the same day.
const fallbackIntervalMs = 6 * 60 * 60 * 1_000;
const requestTimeoutMs = 5_000;
// A deadline this process failed to publish must be retried while it is still awake: the
// platform stops the container a few minutes after the last outbound request, so every retry
// delay stays well under that tail. An unreachable broker therefore keeps this process awake
// rather than letting it sleep on a schedule the broker never acknowledged.
const retryBaseMs = 10_000;
const retryCeilingMs = 60_000;
// Work that arrives earlier than the broker knows about must be published; a deadline that
// merely drifts later is only a cost optimisation. Lease heartbeats push the queue's next
// deadline forward continuously while a job runs, so a tight later-tolerance would turn every
// long job into a stream of pointless requests that also keep the platform awake.
const earlierToleranceMs = 30_000;
const laterToleranceMs = 5 * 60_000;

export interface WakeQueueSource {
  nextWakeAt(nowMs?: number): number | undefined;
}

export interface WakeHintSource {
  nextWakeAt(): number | undefined;
}

export interface WakeDailyBriefSource {
  reconcile(nowMs?: number): DailyBriefScheduleResult;
}

/**
 * Publishes this process's next durable deadline to the external wake broker so the platform
 * can stop the container between deadlines. Every job stays in SQLite: the broker only learns
 * a single absolute timestamp and calls back when it passes.
 */
export class WakeScheduler {
  readonly #queue: WakeQueueSource;
  readonly #receiver: WakeHintSource;
  readonly #dailyBrief: WakeDailyBriefSource;
  readonly #traces: TraceStore;
  readonly #brokerUrl: string | undefined;
  readonly #secret: string | undefined;
  readonly #fetch: typeof fetch;
  #publishedWakeAtMs: number | undefined;
  #failures = 0;
  #retryNotBeforeMs = 0;

  constructor(input: {
    queue: WakeQueueSource;
    receiver: WakeHintSource;
    dailyBrief: WakeDailyBriefSource;
    traces: TraceStore;
    brokerUrl: string | undefined;
    secret: string | undefined;
    fetch?: typeof fetch | undefined;
  }) {
    this.#queue = input.queue;
    this.#receiver = input.receiver;
    this.#dailyBrief = input.dailyBrief;
    this.#traces = input.traces;
    this.#brokerUrl = input.brokerUrl;
    this.#secret = input.secret;
    this.#fetch = input.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get enabled(): boolean {
    return this.#brokerUrl !== undefined && this.#secret !== undefined;
  }

  get publishedWakeAt(): number | undefined {
    return this.#publishedWakeAtMs;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.enabled) {
      return;
    }
    while (!signal.aborted) {
      await this.#pass(Date.now(), false);
      await waitFor(tickIntervalMs, signal);
    }
    // Shutdown is exactly when an unpublished deadline would be lost: the container is about
    // to stop and nothing else will retry. One last bounded attempt, ignoring any backoff.
    await this.#pass(Date.now(), true);
  }

  /** The absolute instant this process next owes itself work. */
  desiredWakeAt(nowMs = Date.now()): number {
    let earliestMs = Math.floor(nowMs / fallbackIntervalMs) * fallbackIntervalMs + fallbackIntervalMs;
    const queueAtMs = this.#queue.nextWakeAt(nowMs);
    if (queueAtMs !== undefined && queueAtMs < earliestMs) {
      earliestMs = queueAtMs;
    }
    const hintAtMs = this.#receiver.nextWakeAt();
    if (hintAtMs !== undefined && hintAtMs < earliestMs) {
      earliestMs = hintAtMs;
    }
    // A scheduled brief is already a queue job; only a deferred one is invisible to the queue.
    const daily = this.#dailyBrief.reconcile(nowMs);
    if (daily.kind === "deferred" && daily.scheduledForMs < earliestMs) {
      earliestMs = daily.scheduledForMs;
    }
    // Anything due sooner than the next whole minute belongs to the loops running right now,
    // not to the broker. Rounding to the minute keeps an overdue deadline from producing a
    // different value on every tick, which would publish in a hot loop while handlers work.
    const nextMinuteAtMs = Math.floor(nowMs / minuteMs) * minuteMs + minuteMs;
    return Math.max(earliestMs, nextMinuteAtMs);
  }

  /** One scheduling pass: compute the deadline and publish it when it materially moved. */
  async tick(signal: AbortSignal, nowMs = Date.now()): Promise<void> {
    if (signal.aborted) {
      return;
    }
    await this.#pass(nowMs, false);
  }

  async #pass(nowMs: number, force: boolean): Promise<void> {
    if (!this.enabled || (!force && nowMs < this.#retryNotBeforeMs)) {
      return;
    }
    const wakeAtMs = this.desiredWakeAt(nowMs);
    const published = this.#publishedWakeAtMs;
    if (
      published !== undefined &&
      wakeAtMs > published - earlierToleranceMs &&
      wakeAtMs < published + laterToleranceMs
    ) {
      return;
    }
    await this.#publish(wakeAtMs, nowMs);
  }

  async #publish(wakeAtMs: number, nowMs: number): Promise<void> {
    const brokerUrl = this.#brokerUrl;
    const secret = this.#secret;
    if (brokerUrl === undefined || secret === undefined) {
      return;
    }
    const traceId = newTraceId();
    // Durable before the request leaves: a crash mid-flight still shows that the broker may
    // hold a deadline this process has not yet acknowledged.
    this.#traces.append({
      traceId,
      component: "wake",
      event: "publish_attempt",
      data: { wakeAtMs, attempt: this.#failures + 1 },
      occurredAtMs: nowMs,
    });

    let status = 0;
    let failure: string | undefined;
    try {
      const response = await this.#fetch(brokerUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ nextWakeAt: wakeAtMs }),
        // Deliberately not bound to shutdown: abandoning an in-flight publish would leave the
        // broker holding a deadline nobody owns. The timeout is what keeps this bounded.
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      status = response.status;
      // Drain without reading the body into anything that could be traced.
      await response.arrayBuffer();
      if (!response.ok) {
        failure = "broker rejected the schedule";
      }
    } catch (error) {
      failure = error instanceof Error ? error.name : "broker request failed";
    }

    if (failure === undefined) {
      // The broker commits its alarm before answering, so recording the acknowledgement here
      // is what makes the schedule durable on this side; only then is it treated as published.
      this.#traces.append({
        traceId,
        component: "wake",
        event: "published",
        outcome: String(status),
        data: { wakeAtMs },
        occurredAtMs: nowMs,
      });
      this.#traces.markTerminal(traceId);
      this.#publishedWakeAtMs = wakeAtMs;
      this.#failures = 0;
      this.#retryNotBeforeMs = 0;
      return;
    }

    this.#failures += 1;
    const retryInMs = Math.min(retryBaseMs * 2 ** (this.#failures - 1), retryCeilingMs);
    this.#retryNotBeforeMs = nowMs + retryInMs;
    this.#traces.append({
      traceId,
      component: "wake",
      event: "publish_failed",
      outcome: failure,
      data: { wakeAtMs, status, retryInMs, attempt: this.#failures },
      occurredAtMs: nowMs,
    });
    this.#traces.markTerminal(traceId);
  }
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}
