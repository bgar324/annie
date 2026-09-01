import type { FastifyInstance } from "fastify";
import type { AssistantRuntime } from "./runtime.js";

export interface RuntimeListener {
  readonly name: "public" | "local_ui";
  readonly app: FastifyInstance;
  readonly host: string;
  readonly port: number;
}

export async function runAssistantProcess(input: {
  runtime: AssistantRuntime;
  listeners: readonly RuntimeListener[];
}): Promise<void> {
  const { runtime } = input;
  const abort = new AbortController();
  let stopping: Promise<void> | undefined;
  let actors: Promise<void> | undefined;
  const opened: RuntimeListener[] = [];
  let binding: Promise<void> | undefined;
  let stopRequested = false;

  const stop = async (reason: string, exitCode = 0): Promise<void> => {
    if (stopping !== undefined) {
      return stopping;
    }
    stopRequested = true;
    stopping = (async () => {
      runtime.setReady(false);
      runtime.app.log.info({ reason }, "assistant_stopping");
      await binding?.catch(() => undefined);
      const httpClosed = Promise.allSettled(
        [...opened].reverse().map((listener) => listener.app.close()),
      );
      abort.abort();
      await actors?.catch(() => undefined);
      const closeResults = await httpClosed;
      const closeFailures = closeResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (closeFailures.length > 0) {
        process.exitCode = 1;
        throw new AggregateError(closeFailures, "One or more HTTP listeners failed to drain");
      }
      runtime.projector.projectPending();
      runtime.database.close();
      process.exitCode = exitCode;
    })();
    return stopping;
  };

  const stopFromSignal = (reason: string): void => {
    void stop(reason).catch((error: unknown) => {
      runtime.app.log.error({ error, reason }, "assistant_stop_failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => stopFromSignal("sigterm"));
  process.once("SIGINT", () => stopFromSignal("sigint"));

  try {
    binding = (async () => {
      for (const listener of input.listeners) {
        if (stopRequested) {
          return;
        }
        const address = await listener.app.listen({
          host: listener.host,
          port: listener.port,
        });
        opened.push(listener);
        runtime.app.log.info({ address, listener: listener.name }, "assistant_listener_ready");
      }
    })();
    await binding;
    if (stopRequested) {
      return;
    }
    runtime.setReady(true);
    runtime.app.log.info(
      { listeners: opened.map((listener) => listener.name) },
      "assistant_ready",
    );

    let actorFailed = false;
    let firstActorFailure: unknown;
    const settleActor = async (actor: Promise<void>): Promise<void> => {
      try {
        await actor;
      } catch (error) {
        if (!actorFailed) {
          actorFailed = true;
          firstActorFailure = error;
          runtime.setReady(false);
          abort.abort();
        }
      }
    };
    actors = Promise.all([
      settleActor(runtime.worker.run(abort.signal)),
      settleActor(runtime.receiver.run(abort.signal)),
      settleActor(runtime.dailyBrief.run(abort.signal)),
    ]).then(() => {
      if (actorFailed) {
        throw firstActorFailure;
      }
    });
    void actors.catch((error: unknown) => {
      runtime.app.log.error({ error }, "background_actor_stopped_unexpectedly");
      void stop("background_actor_failure", 1).catch((stopError: unknown) => {
        runtime.app.log.error({ error: stopError }, "assistant_stop_failed");
        process.exitCode = 1;
      });
    });
  } catch (error) {
    runtime.app.log.error({ error }, "assistant_startup_failed");
    try {
      await stop("startup_failure", 1);
    } catch (stopError) {
      runtime.app.log.error({ error: stopError }, "assistant_stop_failed");
      process.exitCode = 1;
    }
  }
}
