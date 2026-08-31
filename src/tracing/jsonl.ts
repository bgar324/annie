import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { TraceId } from "../core/ids.js";
import type { TraceEventRecord } from "./store.js";
import { TraceStore, traceFileName } from "./store.js";

interface ExportState {
  relative_path: string;
  exported_sequence: number;
  stream_state: "open" | "terminal" | "exported";
  event_count: number;
}

export interface JsonlTraceEvent {
  schemaVersion: 1;
  traceId: TraceId;
  sequence: number;
  occurredAt: string;
  occurredAtMs: number;
  component: string;
  event: string;
  outcome?: string;
  providerRequestId?: string;
  jobId?: string;
  runId?: string;
  toolExecutionId?: string;
  writeIntentId?: string;
  data: unknown;
}

export class TraceProjector {
  readonly #db: Database.Database;
  readonly #store: TraceStore;
  readonly #traceDir: string;

  constructor(db: Database.Database, store: TraceStore, traceDir: string) {
    this.#db = db;
    this.#store = store;
    this.#traceDir = traceDir;
    mkdirSync(traceDir, { recursive: true });
  }

  project(traceId: TraceId): string {
    const state = this.#db
      .prepare<{ trace_id: string }, ExportState>(`
        SELECT exported.relative_path,
               exported.exported_sequence,
               stream.state AS stream_state,
               stream.event_count
        FROM trace_exports AS exported
        JOIN trace_streams AS stream USING (trace_id)
        WHERE exported.trace_id = @trace_id
      `)
      .get({ trace_id: traceId });
    if (state === undefined) {
      throw new Error(`Unknown trace: ${traceId}`);
    }
    if (state.relative_path !== traceFileName(traceId) || basename(state.relative_path) !== state.relative_path) {
      throw new Error(`Unsafe trace path: ${state.relative_path}`);
    }

    const filePath = join(this.#traceDir, state.relative_path);
    const records = this.#store.list(traceId);
    if (records.length !== state.event_count) {
      throw new Error(`Trace ${traceId} spool count does not match stream count`);
    }
    const canonicalLines = records.map((record) => JSON.stringify(toJsonlEvent(record)));
    const existing = readExistingTrace(filePath);
    const prefixMatches =
      existing.clean &&
      existing.lines.length <= canonicalLines.length &&
      existing.lines.every((line, index) => line === canonicalLines[index]);

    if (!prefixMatches) {
      rewriteAtomically(filePath, canonicalLines);
    } else if (existing.lines.length < canonicalLines.length) {
      appendLines(filePath, canonicalLines.slice(existing.lines.length));
    } else if (!existsSync(filePath)) {
      rewriteAtomically(filePath, canonicalLines);
    }

    const terminal = state.stream_state !== "open";
    const digest = terminal ? createHash("sha256").update(readFileSync(filePath)).digest("hex") : null;
    const now = Date.now();
    const update = this.#db.transaction(() => {
      this.#db
        .prepare<{
          trace_id: string;
          sequence: number;
          digest: string | null;
          finalized_at_ms: number | null;
          now_ms: number;
        }>(`
          UPDATE trace_exports
          SET exported_sequence = @sequence,
              file_digest = @digest,
              finalized_at_ms = @finalized_at_ms,
              updated_at_ms = @now_ms
          WHERE trace_id = @trace_id
        `)
        .run({
          trace_id: traceId,
          sequence: records.length,
          digest,
          finalized_at_ms: terminal ? now : null,
          now_ms: now,
        });
      if (terminal) {
        this.#db
          .prepare<{ trace_id: string; event_count: number; now_ms: number }>(`
            UPDATE trace_streams
            SET state = 'exported', updated_at_ms = @now_ms
            WHERE trace_id = @trace_id AND event_count = @event_count
          `)
          .run({ trace_id: traceId, event_count: records.length, now_ms: now });
      }
    });
    update.immediate();
    return filePath;
  }

  projectPending(): string[] {
    return this.#store.listTraceIdsNeedingExport().map((traceId) => this.project(traceId));
  }

  read(traceId: TraceId): JsonlTraceEvent[] {
    const filePath = this.project(traceId);
    return readExistingTrace(filePath).lines.map((line) => JSON.parse(line) as JsonlTraceEvent);
  }
}

function toJsonlEvent(record: TraceEventRecord): JsonlTraceEvent {
  return {
    schemaVersion: 1,
    traceId: record.traceId,
    sequence: record.sequence,
    occurredAt: new Date(record.occurredAtMs).toISOString(),
    occurredAtMs: record.occurredAtMs,
    component: record.component,
    event: record.event,
    ...(record.outcome === null ? {} : { outcome: record.outcome }),
    ...(record.providerRequestId === null ? {} : { providerRequestId: record.providerRequestId }),
    ...(record.jobId === null ? {} : { jobId: record.jobId }),
    ...(record.runId === null ? {} : { runId: record.runId }),
    ...(record.toolExecutionId === null ? {} : { toolExecutionId: record.toolExecutionId }),
    ...(record.writeIntentId === null ? {} : { writeIntentId: record.writeIntentId }),
    data: record.data,
  };
}

interface ExistingTrace {
  lines: string[];
  clean: boolean;
}

function readExistingTrace(filePath: string): ExistingTrace {
  if (!existsSync(filePath)) {
    return { lines: [], clean: true };
  }
  const content = readFileSync(filePath, "utf8");
  if (content.length === 0) {
    return { lines: [], clean: true };
  }
  const lines = content.split("\n");
  const hasFinalNewline = lines.at(-1) === "";
  if (hasFinalNewline) {
    lines.pop();
  }
  const valid: string[] = [];
  for (const line of lines) {
    try {
      JSON.parse(line);
      valid.push(line);
    } catch {
      break;
    }
  }
  return {
    lines: valid,
    clean: hasFinalNewline && valid.length === lines.length,
  };
}

function appendLines(filePath: string, lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  const descriptor = openSync(filePath, "a", 0o600);
  try {
    writeSync(descriptor, `${lines.join("\n")}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function rewriteAtomically(filePath: string, lines: readonly string[]): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const descriptor = openSync(temporaryPath, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
    const directoryDescriptor = openSync(dirname(filePath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
}
