import type { TraceProjector } from "../tracing/jsonl.js";
import { LostLeaseError, QueueStore, type ClaimedJob, type JobType } from "./store.js";

export interface JobContext {
  signal: AbortSignal;
  assertLease(): void;
}

export type JobHandler = (job: ClaimedJob, context: JobContext) => Promise<void>;
export type JobHandlers = Record<JobType, JobHandler>;

export class RetryableJobError extends Error {
  readonly delayMs: number;

  constructor(message: string, delayMs: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableJobError";
    this.delayMs = delayMs;
  }
}

export class BlockedJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlockedJobError";
  }
}

export class DurableWorker {
  readonly #queue: QueueStore;
  readonly #handlers: JobHandlers;
  readonly #projector: TraceProjector;
  readonly #pollMs: number;
  readonly #heartbeatMs: number;
  readonly #log: (level: "debug" | "warn" | "error", message: string, data?: unknown) => void;
  #activeJob: ClaimedJob | undefined;

  constructor(input: {
    queue: QueueStore;
    handlers: JobHandlers;
    projector: TraceProjector;
    pollMs: number;
    leaseMs: number;
    log?: (level: "debug" | "warn" | "error", message: string, data?: unknown) => void;
  }) {
    this.#queue = input.queue;
    this.#handlers = input.handlers;
    this.#projector = input.projector;
    this.#pollMs = input.pollMs;
    this.#heartbeatMs = Math.max(1_000, Math.floor(input.leaseMs / 3));
    this.#log = input.log ?? (() => undefined);
  }

  get activeJob(): ClaimedJob | undefined {
    return this.#activeJob;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const job = this.#queue.claim();
      if (job === undefined) {
        await waitFor(this.#pollMs, signal);
        continue;
      }
      this.#activeJob = job;
      await this.#process(job, signal);
      this.#activeJob = undefined;
    }
  }

  releaseActiveForShutdown(): boolean {
    return this.#activeJob === undefined || this.#queue.releaseForShutdown(this.#activeJob);
  }

  async #process(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      try {
        this.#queue.heartbeat(job);
      } catch (error) {
        heartbeatFailure = error;
      }
    }, this.#heartbeatMs);
    heartbeat.unref();

    const context: JobContext = {
      signal,
      assertLease: () => {
        if (heartbeatFailure !== undefined) {
          throw heartbeatFailure;
        }
        this.#queue.assertLease(job);
      },
    };

    try {
      await this.#handlers[job.type](job, context);
      context.assertLease();
      this.#queue.complete(job);
    } catch (error) {
      if (error instanceof LostLeaseError) {
        this.#log("warn", "Worker lost job lease", { jobId: job.id });
      } else if (error instanceof BlockedJobError) {
        this.#queue.block(job, error.message);
      } else if (error instanceof RetryableJobError) {
        this.#queue.requeue(job, Date.now() + error.delayMs, error.message);
      } else {
        const message = error instanceof Error ? error.message : "Unknown job failure";
        this.#queue.fail(job, message);
        this.#log("error", "Job failed", { jobId: job.id, type: job.type, error });
      }
    } finally {
      clearInterval(heartbeat);
      try {
        this.#projector.project(job.traceId);
      } catch (error) {
        this.#log("error", "Trace projection failed", { traceId: job.traceId, error });
      }
    }
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
