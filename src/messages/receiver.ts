import type Database from "better-sqlite3";
import { newTraceId, type TraceId } from "../core/ids.js";
import { QueueCapacityError } from "../queue/store.js";
import type { TraceEvictionService } from "../tracing/eviction.js";
import type { TraceProjector } from "../tracing/jsonl.js";
import type { TraceEventInput, TraceStore } from "../tracing/store.js";
import { MessageIngressService } from "./inbound.js";
import {
  MessagingProviderError,
  type InboundMessageSource,
} from "./types.js";

const pollIntervalMs = 5_000;
const recoveryOverlapMs = 60_000;
const pageSize = 100;
const pollTraceLifetimeMs = 15 * 60_000;
const pollTraceEventLimit = 1_800;

interface CursorRow {
  updated_at_ms: number;
  recovered_once: 0 | 1;
}

export class SendblueReceiver {
  readonly #db: Database.Database;
  readonly #gateway: InboundMessageSource;
  readonly #ingress: MessageIngressService;
  readonly #traces: TraceStore;
  readonly #projector: TraceProjector;
  readonly #eviction: TraceEvictionService;
  #initialized = false;
  #wakeVersion = 0;
  #wakeWaiter: (() => void) | undefined;
  #pollTraceId: TraceId | undefined;
  #pollTraceStartedAtMs = 0;
  #pollTraceEvents = 0;

  constructor(input: {
    db: Database.Database;
    gateway: InboundMessageSource;
    ingress: MessageIngressService;
    traces: TraceStore;
    projector: TraceProjector;
    eviction: TraceEvictionService;
  }) {
    this.#db = input.db;
    this.#gateway = input.gateway;
    this.#ingress = input.ingress;
    this.#traces = input.traces;
    this.#projector = input.projector;
    this.#eviction = input.eviction;
  }

  initialize(nowMs = Date.now()): void {
    if (this.#initialized) {
      return;
    }
    const transaction = this.#db.transaction(() => {
      this.#db
        .prepare(`
          UPDATE trace_streams
          SET state = 'terminal', updated_at_ms = @now_ms
          WHERE state = 'open'
            AND trace_id IN (
              SELECT trace_id FROM trace_event_spool
              WHERE component IN ('sendblue_poll', 'sendblue_stream')
            )
        `)
        .run({ now_ms: nowMs });
      this.#db
        .prepare<{
          updated_at_ms: number;
        }>(`
          INSERT INTO sendblue_ingress_cursor(id, updated_at_ms, recovered_once)
          VALUES (1, @updated_at_ms, 0)
          ON CONFLICT(id) DO NOTHING
        `)
        .run({ updated_at_ms: nowMs });
    });
    transaction.immediate();
    this.#initialized = true;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.initialize();
    try {
      await Promise.all([this.#runSweeps(signal), this.#runWakeStream(signal)]);
    } finally {
      this.close();
    }
  }

  async sweepOnce(signal: AbortSignal): Promise<void> {
    this.initialize();
    this.#ensurePollTrace();
    const traceId = this.#requiredPollTrace();
    const cursor = this.#cursor();
    const floorMs =
      cursor.recovered_once === 0
        ? cursor.updated_at_ms
        : Math.max(0, cursor.updated_at_ms - recoveryOverlapMs);
    let offset = 0;
    let total: number | undefined;

    try {
      for (;;) {
        this.#appendPoll({
          traceId,
          component: "sendblue_poll",
          event: "page_attempted",
          outcome: "messages_list",
          data: { offset, limit: pageSize, floorMs },
        });
        const page = await this.#gateway.listInbound({
          updatedAtGteMs: floorMs,
          limit: pageSize,
          offset,
          signal,
        });
        total ??= page.total;
        this.#appendPoll({
          traceId,
          component: "sendblue_poll",
          event: "page_completed",
          outcome: "success",
          providerRequestId: page.requestId,
          data: { offset, messageCount: page.messages.length, total },
        });

        let pageWatermark = cursor.updated_at_ms;
        for (const message of page.messages) {
          this.#ingress.ingest(message);
          pageWatermark = Math.max(pageWatermark, message.updatedAtMs);
        }
        this.#advanceCursor(pageWatermark);
        offset += page.messages.length;
        if (offset >= total) {
          break;
        }
        if (page.messages.length === 0) {
          throw new MessagingProviderError({
            message: "Sendblue pagination stopped before its reported total",
            kind: "terminal",
          });
        }
      }
      this.#markRecovered();
      this.#projectPollTrace();
    } catch (error) {
      this.#appendPoll({
        traceId,
        component: "sendblue_poll",
        event: "sweep_failed",
        outcome: error instanceof MessagingProviderError ? error.kind : "unknown",
        providerRequestId:
          error instanceof MessagingProviderError ? error.requestId : undefined,
        data: {
          offset,
          status: error instanceof MessagingProviderError ? error.status : undefined,
          failureType: error instanceof Error ? error.name : "unknown",
        },
      });
      this.#projectPollTrace();
      throw error;
    }
  }

  close(): void {
    const traceId = this.#pollTraceId;
    if (traceId === undefined) {
      return;
    }
    this.#appendPoll({
      traceId,
      component: "sendblue_poll",
      event: "receiver_stopped",
      outcome: "closed",
      data: {},
    });
    if (this.#eviction.evictUnlessEvents(traceId, ["sweep_failed"])) {
      this.#pollTraceId = undefined;
      this.#wakeWaiter?.();
      return;
    }
    this.#projectPollTrace();
    this.#pollTraceId = undefined;
    this.#wakeWaiter?.();
  }
  async #runSweeps(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const observedWake = this.#wakeVersion;
      try {
        await this.sweepOnce(signal);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof QueueCapacityError) {
          await waitFor(pollIntervalMs, signal);
          continue;
        }
        if (!(error instanceof MessagingProviderError) || error.kind === "terminal") {
          throw error;
        }
        await waitFor(error.retryAfterMs ?? pollIntervalMs, signal);
        continue;
      }
      if (this.#wakeVersion !== observedWake) {
        continue;
      }
      await this.#waitForWake(signal);
    }
  }

  async #runWakeStream(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const traceId = newTraceId();
      this.#traces.append({
        traceId,
        component: "sendblue_stream",
        event: "stream_attempted",
        outcome: "events_stream",
        data: {},
      });
      try {
        const stream = await this.#gateway.openInboundWakeStream(signal);
        this.#traces.append({
          traceId,
          component: "sendblue_stream",
          event: "stream_opened",
          outcome: "connected",
          providerRequestId: stream.requestId,
          data: {},
        });
        failures = 0;
        for await (const _event of stream.events) {
          if (signal.aborted) {
            break;
          }
          this.#wake();
        }
        this.#traces.append({
          traceId,
          component: "sendblue_stream",
          event: "stream_closed",
          outcome: signal.aborted ? "shutdown" : "rotated",
          data: {},
        });
      } catch (error) {
        if (signal.aborted) {
          this.#traces.append({
            traceId,
            component: "sendblue_stream",
            event: "stream_closed",
            outcome: "shutdown",
            data: {},
          });
        } else if (error instanceof MessagingProviderError) {
          this.#traces.append({
            traceId,
            component: "sendblue_stream",
            event: "stream_failed",
            outcome: error.kind,
            providerRequestId: error.requestId,
            data: { status: error.status },
          });
          if (error.kind === "terminal") {
            this.#traces.markTerminal(traceId);
            this.#project(traceId);
            return;
          }
          failures += 1;
        } else {
          this.#traces.append({
            traceId,
            component: "sendblue_stream",
            event: "stream_failed",
            outcome: "unknown",
            data: { failureType: error instanceof Error ? error.name : "unknown" },
          });
          this.#traces.markTerminal(traceId);
          this.#project(traceId);
          throw error;
        }
      }
      this.#traces.markTerminal(traceId);
      if (!this.#eviction.evictUnlessEvents(traceId, ["stream_failed"])) {
        this.#project(traceId);
      }
      if (!signal.aborted && failures > 0) {
        await waitFor(Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)), signal);
      }
    }
  }

  #cursor(): CursorRow {
    const row = this.#db
      .prepare<[], CursorRow>(`
        SELECT updated_at_ms, recovered_once
        FROM sendblue_ingress_cursor WHERE id = 1
      `)
      .get();
    if (row === undefined) {
      throw new Error("Sendblue ingress cursor is not initialized");
    }
    return row;
  }

  #advanceCursor(updatedAtMs: number): void {
    this.#db
      .prepare<{ updated_at_ms: number }>(`
        UPDATE sendblue_ingress_cursor
        SET updated_at_ms = MAX(updated_at_ms, @updated_at_ms)
        WHERE id = 1
      `)
      .run({ updated_at_ms: updatedAtMs });
  }

  #markRecovered(): void {
    this.#db
      .prepare("UPDATE sendblue_ingress_cursor SET recovered_once = 1 WHERE id = 1")
      .run();
  }

  #wake(): void {
    this.#wakeVersion += 1;
    this.#wakeWaiter?.();
  }

  async #waitForWake(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.#wakeWaiter === done) {
          this.#wakeWaiter = undefined;
        }
        resolve();
      };
      const timer = setTimeout(done, pollIntervalMs);
      timer.unref();
      this.#wakeWaiter = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #ensurePollTrace(nowMs = Date.now()): void {
    if (
      this.#pollTraceId !== undefined &&
      nowMs - this.#pollTraceStartedAtMs < pollTraceLifetimeMs &&
      this.#pollTraceEvents < pollTraceEventLimit
    ) {
      return;
    }
    if (this.#pollTraceId !== undefined) {
      this.close();
    }
    const traceId = newTraceId();
    this.#pollTraceId = traceId;
    this.#pollTraceStartedAtMs = nowMs;
    this.#pollTraceEvents = 0;
    this.#appendPoll({
      traceId,
      component: "sendblue_poll",
      event: "receiver_started",
      outcome: "active",
      data: {},
      occurredAtMs: nowMs,
    });
  }

  #requiredPollTrace(): TraceId {
    if (this.#pollTraceId === undefined) {
      throw new Error("Sendblue poll trace is not initialized");
    }
    return this.#pollTraceId;
  }

  #appendPoll(input: TraceEventInput): void {
    this.#traces.append(input);
    this.#pollTraceEvents += 1;
  }

  #projectPollTrace(): void {
    if (this.#pollTraceId !== undefined) {
      this.#project(this.#pollTraceId);
    }
  }

  #project(traceId: TraceId): void {
    try {
      this.#projector.project(traceId);
    } catch {
      // The durable spool repairs this projection on the next worker or startup pass.
    }
  }
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}
