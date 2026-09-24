import { createHash } from "node:crypto";
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

const recoveryOverlapMs = 60_000;
const pageSize = 100;
const transientRetryMs = 5_000;
const sweepTraceEventLimit = 512;
const sweepFailureEvents = ["sweep_failed", "hint_abandoned"];
const sweepHintId = "sweep";
const messageHintPrefix = "msg:";
const maximumHintMessageIdCharacters = 128;
const maximumHints = 256;
const hintLifetimeMs = 10 * 60_000;
// A webhook can beat the list endpoint that has to prove it, so an unconfirmed hint is
// retried on this schedule and then abandoned: bounded work, never an endless poll.
const hintRetryBackoffMs = [1_000, 2_000, 5_000, 15_000, 30_000];

interface CursorRow {
  updated_at_ms: number;
  recovered_once: 0 | 1;
}

interface HintRow {
  id: string;
  provider_message_id: string | null;
  attempts: number;
  expires_at_ms: number;
  request_count: number;
  /** 1 when the hint's retry has come due, 0 while it is waiting out its backoff. */
  due: number;
}

interface HintResolution {
  confirmed: number;
  pending: number;
  abandoned: number;
}

/**
 * Ingests Sendblue messages from the authoritative paged list, and only from it.
 *
 * The receiver holds no provider connection while it is idle. Something outside it —
 * an authenticated webhook, the wake broker, a restart — commits a durable hint with
 * {@link SendblueReceiver.requestWake}, and this loop turns that hint into one paged
 * sweep. A hint is a reason to look, never a message: a claimed provider message id is
 * cleared only once a committed delivery row proves the list showed it.
 */
export class SendblueReceiver {
  readonly #db: Database.Database;
  readonly #gateway: InboundMessageSource;
  readonly #ingress: MessageIngressService;
  readonly #traces: TraceStore;
  readonly #projector: TraceProjector;
  readonly #eviction: TraceEvictionService;
  #initialized = false;
  #wakeWaiter: (() => void) | undefined;
  #sweepTraceId: TraceId | undefined;
  #sweepTraceEvents = 0;

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

  /**
   * Commits a durable reason to sweep, synchronously and without touching the network.
   * A caller may acknowledge its webhook or broker wake as soon as this returns: the
   * hint outlives a crash and survives every sweep until an authoritative page answers
   * it. `providerMessageId` is a claim to look for, never message content; omit it for
   * a plain "look now" wake.
   */
  requestWake(providerMessageId?: string, nowMs = Date.now()): void {
    this.initialize(nowMs);
    const claimedId =
      providerMessageId !== undefined &&
      providerMessageId.length > 0 &&
      providerMessageId.length <= maximumHintMessageIdCharacters
        ? providerMessageId
        : undefined;
    const commit = this.#db.transaction(() => {
      // At capacity the claim degrades to a plain wake rather than growing the table:
      // the sweep still happens, only the per-message proof is given up.
      const hintMessageId =
        claimedId !== undefined && this.#hasHintRoom(claimedId) ? claimedId : null;
      this.#db
        .prepare<{
          id: string;
          provider_message_id: string | null;
          now_ms: number;
          expires_at_ms: number;
        }>(`
          INSERT INTO sendblue_wake_hints(
            id, provider_message_id, due_at_ms, attempts, expires_at_ms,
            request_count, created_at_ms, updated_at_ms
          ) VALUES (
            @id, @provider_message_id, @now_ms, 0, @expires_at_ms,
            1, @now_ms, @now_ms
          )
          ON CONFLICT(id) DO UPDATE SET
            due_at_ms = MIN(due_at_ms, @now_ms),
            attempts = 0,
            request_count = request_count + 1,
            updated_at_ms = @now_ms
        `)
        .run({
          id: hintMessageId === null ? sweepHintId : `${messageHintPrefix}${hintMessageId}`,
          provider_message_id: hintMessageId,
          now_ms: nowMs,
          expires_at_ms: nowMs + hintLifetimeMs,
        });
    });
    commit.immediate();
    this.#wakeWaiter?.();
  }

  /** Epoch milliseconds of the earliest durable hint, or undefined when none is pending. */
  nextWakeAt(): number | undefined {
    const row = this.#db
      .prepare<[], { due_at_ms: number | null }>(
        "SELECT MIN(due_at_ms) AS due_at_ms FROM sendblue_wake_hints",
      )
      .get();
    return row?.due_at_ms ?? undefined;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.initialize();
    // Every webhook aimed at a stopped process missed it, so startup is itself a reason
    // to sweep. Hints committed before the stop are still durable and still due.
    this.requestWake();
    try {
      while (!signal.aborted) {
        const dueAtMs = this.nextWakeAt();
        if (dueAtMs === undefined) {
          // Nothing is pending: hold no provider connection and no timer, and wait for
          // requestWake or shutdown.
          await this.#waitForWake(signal);
          continue;
        }
        const delayMs = dueAtMs - Date.now();
        if (delayMs > 0) {
          await this.#waitForWake(signal, delayMs);
          continue;
        }
        try {
          await this.sweepOnce(signal);
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          if (error instanceof QueueCapacityError) {
            await this.#waitForWake(signal, transientRetryMs);
            continue;
          }
          if (!(error instanceof MessagingProviderError) || error.kind === "terminal") {
            throw error;
          }
          await this.#waitForWake(signal, error.retryAfterMs ?? transientRetryMs);
        }
      }
    } finally {
      this.close();
    }
  }

  async sweepOnce(signal: AbortSignal): Promise<void> {
    this.initialize();
    const startedAtMs = Date.now();
    // Claimed before the first request leaves: a page already in flight cannot answer a
    // hint committed after it, so anything arriving mid-sweep stays due for the next one.
    const claimed = this.#claimHints(startedAtMs);
    const cursor = this.#cursor();
    const floorMs =
      cursor.recovered_once === 0
        ? cursor.updated_at_ms
        : Math.max(0, cursor.updated_at_ms - recoveryOverlapMs);
    const traceId = this.#startSweepTrace(startedAtMs, claimed.length, floorMs);
    let offset = 0;
    let total: number | undefined;
    let accepted = 0;

    try {
      for (;;) {
        this.#appendSweep({
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
        this.#appendSweep({
          traceId,
          component: "sendblue_poll",
          event: "page_completed",
          outcome: "success",
          providerRequestId: page.requestId,
          data: { offset, messageCount: page.messages.length, total },
        });

        let pageWatermark = cursor.updated_at_ms;
        for (const message of page.messages) {
          if (this.#ingress.ingest(message).kind === "accepted") {
            accepted += 1;
          }
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
      const resolution = this.#resolveHints(claimed, Date.now(), traceId);
      this.#appendSweep({
        traceId,
        component: "sendblue_poll",
        event: "sweep_completed",
        outcome: "success",
        data: {
          accepted,
          confirmedHints: resolution.confirmed,
          pendingHints: resolution.pending,
          abandonedHints: resolution.abandoned,
        },
      });
      // A sweep that ingested nothing and confirmed everything has nothing to debug.
      this.#finishSweepTrace(traceId, accepted > 0 || resolution.abandoned > 0);
    } catch (error) {
      this.#appendSweep({
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
      this.#finishSweepTrace(traceId, true);
      throw error;
    }
  }

  close(): void {
    const traceId = this.#sweepTraceId;
    if (traceId === undefined) {
      this.#wakeWaiter?.();
      return;
    }
    this.#appendSweep({
      traceId,
      component: "sendblue_poll",
      event: "receiver_stopped",
      outcome: "closed",
      data: {},
    });
    this.#sweepTraceId = undefined;
    this.#sweepTraceEvents = 0;
    this.#traces.markTerminal(traceId);
    if (!this.#eviction.evictUnlessEvents(traceId, sweepFailureEvents)) {
      this.#project(traceId);
    }
    this.#wakeWaiter?.();
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

  #hasHintRoom(providerMessageId: string): boolean {
    const row = this.#db
      .prepare<{ id: string }, { total: number; present: number }>(`
        SELECT
          (SELECT COUNT(*) FROM sendblue_wake_hints) AS total,
          EXISTS(SELECT 1 FROM sendblue_wake_hints WHERE id = @id) AS present
      `)
      .get({ id: `${messageHintPrefix}${providerMessageId}` });
    return row !== undefined && (row.present === 1 || row.total < maximumHints);
  }

  /**
   * Every hint that exists before the first page leaves. A sweep is authoritative for
   * all of them, so one already answered can be cleared even before its retry is due;
   * only a hint whose retry has come due spends part of its budget.
   */
  #claimHints(nowMs: number): readonly HintRow[] {
    return this.#db
      .prepare<{ now_ms: number; limit: number }, HintRow>(`
        SELECT
          id, provider_message_id, attempts, expires_at_ms, request_count,
          due_at_ms <= @now_ms AS due
        FROM sendblue_wake_hints
        ORDER BY due_at_ms
        LIMIT @limit
      `)
      .all({ now_ms: nowMs, limit: maximumHints });
  }

  #resolveHints(
    claimed: readonly HintRow[],
    nowMs: number,
    traceId: TraceId,
  ): HintResolution {
    if (claimed.length === 0) {
      return { confirmed: 0, pending: 0, abandoned: 0 };
    }
    const resolve = this.#db.transaction((): HintResolution => {
      let confirmed = 0;
      let pending = 0;
      let abandoned = 0;
      for (const hint of claimed) {
        const claimedId = hint.provider_message_id;
        if (claimedId === null || this.#deliveryExists(claimedId)) {
          if (this.#settleHint(hint)) {
            confirmed += 1;
          } else {
            pending += 1;
          }
          continue;
        }
        if (hint.due !== 1) {
          pending += 1;
          continue;
        }
        const attempts = hint.attempts + 1;
        const backoffMs = hintRetryBackoffMs[attempts - 1];
        const dueAtMs = backoffMs === undefined ? undefined : nowMs + backoffMs;
        if (dueAtMs === undefined || dueAtMs >= hint.expires_at_ms) {
          if (!this.#settleHint(hint)) {
            pending += 1;
            continue;
          }
          abandoned += 1;
          this.#appendSweepInTransaction({
            traceId,
            component: "sendblue_poll",
            event: "hint_abandoned",
            outcome: "never_listed",
            data: {
              hintDigest: wakeHintDigest(claimedId),
              attempts,
            },
            occurredAtMs: nowMs,
          });
          continue;
        }
        this.#db
          .prepare<{
            id: string;
            due_at_ms: number;
            attempts: number;
            request_count: number;
            now_ms: number;
          }>(`
            UPDATE sendblue_wake_hints
            SET due_at_ms = @due_at_ms, attempts = @attempts, updated_at_ms = @now_ms
            WHERE id = @id AND request_count = @request_count
          `)
          .run({
            id: hint.id,
            due_at_ms: dueAtMs,
            attempts,
            request_count: hint.request_count,
            now_ms: nowMs,
          });
        pending += 1;
      }
      this.#appendSweepInTransaction({
        traceId,
        component: "sendblue_poll",
        event: "hints_resolved",
        outcome: pending === 0 ? "settled" : "awaiting_list",
        data: { confirmed, pending, abandoned },
        occurredAtMs: nowMs,
      });
      return { confirmed, pending, abandoned };
    });
    return resolve.immediate();
  }

  /**
   * Clears a hint this sweep answered. A wake that arrived while the sweep was running
   * bumps `request_count`, so it keeps the row and earns its own sweep instead of being
   * swallowed by this one.
   */
  #settleHint(hint: HintRow): boolean {
    const result = this.#db
      .prepare<{ id: string; request_count: number }>(
        "DELETE FROM sendblue_wake_hints WHERE id = @id AND request_count = @request_count",
      )
      .run({ id: hint.id, request_count: hint.request_count });
    return result.changes === 1;
  }

  /**
   * Delivery rows are written only by ingress, only from a listed page, so their
   * presence is the proof that the authoritative list showed a claimed message id.
   */
  #deliveryExists(providerMessageId: string): boolean {
    const row = this.#db
      .prepare<{ provider_message_id: string }, { listed: number }>(`
        SELECT 1 AS listed FROM webhook_deliveries
        WHERE provider_message_id = @provider_message_id
        LIMIT 1
      `)
      .get({ provider_message_id: providerMessageId });
    return row !== undefined;
  }


  async #waitForWake(signal: AbortSignal, delayMs?: number): Promise<void> {
    if (signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal.removeEventListener("abort", done);
        if (this.#wakeWaiter === done) {
          this.#wakeWaiter = undefined;
        }
        resolve();
      };
      if (delayMs !== undefined) {
        timer = setTimeout(done, delayMs);
        timer.unref();
      }
      this.#wakeWaiter = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #startSweepTrace(nowMs: number, hints: number, floorMs: number): TraceId {
    if (this.#sweepTraceId !== undefined) {
      this.close();
    }
    const traceId = newTraceId();
    this.#sweepTraceId = traceId;
    this.#sweepTraceEvents = 0;
    this.#appendSweep({
      traceId,
      component: "sendblue_poll",
      event: "sweep_started",
      outcome: "active",
      data: { hints, floorMs },
      occurredAtMs: nowMs,
    });
    return traceId;
  }

  #finishSweepTrace(traceId: TraceId, keep: boolean): void {
    if (this.#sweepTraceId !== traceId) {
      return;
    }
    this.#sweepTraceId = undefined;
    this.#sweepTraceEvents = 0;
    this.#traces.markTerminal(traceId);
    if (!keep && this.#eviction.evictTrace(traceId)) {
      return;
    }
    this.#project(traceId);
  }

  #appendSweep(input: TraceEventInput): void {
    const event = this.#sweepEvent(input);
    if (event !== undefined) {
      this.#traces.append(event);
    }
  }

  #appendSweepInTransaction(input: TraceEventInput): void {
    const event = this.#sweepEvent(input);
    if (event !== undefined) {
      this.#traces.appendInTransaction(event);
    }
  }

  /** Drops events for a finished trace and caps a pathological backlog at one notice. */
  #sweepEvent(input: TraceEventInput): TraceEventInput | undefined {
    if (this.#sweepTraceId !== input.traceId || this.#sweepTraceEvents >= sweepTraceEventLimit) {
      return undefined;
    }
    this.#sweepTraceEvents += 1;
    if (this.#sweepTraceEvents < sweepTraceEventLimit) {
      return input;
    }
    return {
      traceId: input.traceId,
      component: "sendblue_poll",
      event: "trace_truncated",
      outcome: "event_limit",
      data: { limit: sweepTraceEventLimit },
      ...(input.occurredAtMs === undefined ? {} : { occurredAtMs: input.occurredAtMs }),
    };
  }

  #project(traceId: TraceId): void {
    try {
      this.#projector.project(traceId);
    } catch {
      // The durable spool repairs this projection on the next worker or startup pass.
    }
  }
}

/**
 * Correlates a claimed provider message id across logs and traces without recording the
 * claim itself: until a page lists it, the id is an unverified assertion from a caller.
 */
export function wakeHintDigest(providerMessageId: string): string {
  return createHash("sha256").update(providerMessageId).digest("hex").slice(0, 16);
}
