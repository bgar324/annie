import { loadLocalEnv, loadRuntimeConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

loadLocalEnv();
const config = loadRuntimeConfig();
const runtime = await createRuntime(config);
const abort = new AbortController();
let stopping: Promise<void> | undefined;
let actors: Promise<void> | undefined;

async function stop(reason: string, exitCode = 0): Promise<void> {
  if (stopping !== undefined) {
    return stopping;
  }
  stopping = (async () => {
    runtime.setReady(false);
    runtime.app.log.info({ reason }, "assistant_stopping");
    const httpClosed = runtime.app.close();
    abort.abort();
    await actors?.catch(() => undefined);
    await httpClosed;
    runtime.projector.projectPending();
    runtime.database.close();
    process.exitCode = exitCode;
  })();
  return stopping;
}

process.once("SIGTERM", () => void stop("sigterm"));
process.once("SIGINT", () => void stop("sigint"));

try {
  const address = await runtime.app.listen({ host: config.host, port: config.port });
  runtime.setReady(true);
  runtime.app.log.info({ address }, "assistant_ready");
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
    void stop("background_actor_failure", 1);
  });
} catch (error) {
  runtime.app.log.error({ error }, "assistant_startup_failed");
  await stop("startup_failure", 1);
}
