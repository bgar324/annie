import type { RunId, TraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { WriteStore } from "../writes/store.js";
import type { MessageSender } from "./types.js";

// Long enough to cover a tool-bearing turn; the bubble clears on its own if the reply is
// late, and Sendblue ends it when the reply lands.
const typingDurationMs = 60_000;

/**
 * Shows the user a typing bubble while a turn runs. A provider mutation like any other:
 * one durable `sendblue_typing_indicator` intent committed as `attempting` before the
 * call, settled after it, never retried or replayed. Unlike a message, an unconfirmed
 * bubble harms nothing, so recovery marks it ambiguous without blocking the run, and a
 * failure here is traced and otherwise ignored: the reply is what matters.
 */
export class TypingIndicatorService {
  readonly #sender: MessageSender;
  readonly #writes: WriteStore;
  readonly #traces: TraceStore;
  readonly #recipient: string;

  constructor(input: {
    sender: MessageSender;
    writes: WriteStore;
    traces: TraceStore;
    recipient: string;
  }) {
    this.#sender = input.sender;
    this.#writes = input.writes;
    this.#traces = input.traces;
    this.#recipient = input.recipient;
  }

  /** Never throws; the caller must not await this on the critical path. */
  async start(input: { runId: RunId; traceId: TraceId }): Promise<void> {
    const request = { to: this.#recipient, state: "start", maxDurationMs: typingDurationMs };
    let write;
    try {
      write = this.#writes.prepare({
        traceId: input.traceId,
        runId: input.runId,
        kind: "sendblue_typing_indicator",
        request,
        safeSummary: { maxDurationMs: typingDurationMs },
      });
      this.#writes.beginAttempt({ writeId: write.id, traceId: input.traceId });
    } catch (error) {
      this.#trace(input.traceId, input.runId, "skipped", error);
      return;
    }
    try {
      await this.#sender.startTyping({ to: this.#recipient, maxDurationMs: typingDurationMs });
      this.#writes.complete({
        writeId: write.id,
        traceId: input.traceId,
        state: "succeeded",
        normalizedResult: { ok: true },
      });
    } catch (error) {
      const kind = error instanceof Error && "kind" in error ? String(error.kind) : "unknown";
      this.#writes.complete({
        writeId: write.id,
        traceId: input.traceId,
        state: kind === "terminal" ? "confirmed_failed" : "ambiguous",
        normalizedResult: { ok: false, error: { code: kind } },
      });
      this.#trace(input.traceId, input.runId, kind, error);
    }
  }

  #trace(traceId: TraceId, runId: RunId, outcome: string, error: unknown): void {
    this.#traces.append({
      traceId,
      runId,
      component: "typing_indicator",
      event: "failed",
      outcome,
      data: { message: (error instanceof Error ? error.message : String(error)).slice(0, 200) },
    });
  }
}
