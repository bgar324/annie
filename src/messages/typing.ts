import { setTimeout as sleep } from "node:timers/promises";
import type { RunId, TraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { MessageSender } from "./types.js";

// One indicator does not span a turn: production replies land 22 to 51 seconds after the
// message, and the bubble was gone long before. Re-sending well inside any plausible
// provider timeout keeps it continuous for as long as the turn runs.
const defaultRefreshMs = 8_000;

/**
 * Shows the user a typing bubble for as long as a turn runs, and stops when it ends.
 *
 * Not a durable write: the call creates nothing, changes nothing a later read can observe,
 * and its worst failure is no bubble, so it carries no write intent and never blocks or
 * delays a turn. Sendblue documents it as best-effort with no delivery confirmation.
 * Failures are traced once and otherwise ignored; the reply is what matters.
 */
export class TypingIndicatorService {
  readonly #sender: MessageSender;
  readonly #traces: TraceStore;
  readonly #recipient: string;
  readonly #refreshMs: number;

  constructor(input: {
    sender: MessageSender;
    traces: TraceStore;
    recipient: string;
    refreshMs?: number;
  }) {
    this.#sender = input.sender;
    this.#traces = input.traces;
    this.#recipient = input.recipient;
    this.#refreshMs = input.refreshMs ?? defaultRefreshMs;
  }

  /**
   * Starts the bubble and keeps it alive. Returns the stop function; the caller must call
   * it when the turn ends, and must not await the bubble on the reply path.
   */
  start(input: { runId: RunId; traceId: TraceId }): () => void {
    const controller = new AbortController();
    void this.#keepAlive(input, controller.signal);
    return () => controller.abort();
  }

  async #keepAlive(input: { runId: RunId; traceId: TraceId }, signal: AbortSignal): Promise<void> {
    let traced = false;
    while (!signal.aborted) {
      try {
        await this.#sender.startTyping({ to: this.#recipient });
      } catch (error) {
        // One trace per turn: a provider outage would otherwise log every refresh.
        if (!traced) {
          traced = true;
          this.#traces.append({
            traceId: input.traceId,
            runId: input.runId,
            component: "typing_indicator",
            event: "failed",
            outcome: error instanceof Error && "kind" in error ? String(error.kind) : "unknown",
            data: { message: (error instanceof Error ? error.message : String(error)).slice(0, 200) },
          });
        }
      }
      try {
        await sleep(this.#refreshMs, undefined, { signal });
      } catch {
        return;
      }
    }
  }
}
