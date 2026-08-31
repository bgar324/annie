import { pathToFileURL } from "node:url";
import { asTraceId } from "./core/ids.js";
import { loadLocalEnv, loadStorageConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { buildSafeReplay, renderSafeReplay } from "./replay.js";
import { TraceProjector } from "./tracing/jsonl.js";
import { createTraceRedactor } from "./tracing/redaction.js";
import { explainTrace, renderTrace } from "./tracing/render.js";
import { TraceStore } from "./tracing/store.js";

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export function runCli(
  argumentsValue: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
): number {
  const [command, traceValue, ...extra] = argumentsValue;
  if (
    (command !== "trace" && command !== "replay") ||
    traceValue === undefined ||
    extra.length > 0
  ) {
    io.stderr("Usage: pnpm trace -- <trace-id> | pnpm replay -- <trace-id>\n");
    return 2;
  }

  try {
    const traceId = asTraceId(traceValue);
    const storage = loadStorageConfig(env);
    const database = openDatabase(storage);
    try {
      if (command === "trace") {
        const traces = new TraceStore(database.db, createTraceRedactor([]));
        const projector = new TraceProjector(database.db, traces, storage.traceDir);
        const events = projector.read(traceId);
        io.stdout(renderTrace(events));
        io.stdout(explainTrace(events));
      } else {
        io.stdout(renderSafeReplay(buildSafeReplay(database.db, traceId)));
      }
    } finally {
      database.close();
    }
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Unknown CLI failure"}\n`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  loadLocalEnv();
  process.exitCode = runCli(process.argv.slice(2));
}
