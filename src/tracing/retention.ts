import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type Database from "better-sqlite3";
import type { TraceId } from "../core/ids.js";

interface RetainedTraceRow {
  trace_id: TraceId;
  relative_path: string;
  finalized_at_ms: number;
}

export interface TraceRetentionResult {
  deletedTraceIds: readonly TraceId[];
  deletedOrphanFiles: number;
  retainedBytes: number;
}

export class TraceRetentionService {
  readonly #db: Database.Database;
  readonly #traceDir: string;
  readonly #retentionMs: number;
  readonly #maximumBytes: number;

  constructor(input: {
    db: Database.Database;
    traceDir: string;
    retentionDays: number;
    maximumBytes: number;
  }) {
    this.#db = input.db;
    this.#traceDir = input.traceDir;
    this.#retentionMs = input.retentionDays * 24 * 60 * 60 * 1_000;
    this.#maximumBytes = input.maximumBytes;
  }

  cleanup(nowMs = Date.now()): TraceRetentionResult {
    const rows = this.#db
      .prepare<[], RetainedTraceRow>(`
        SELECT exports.trace_id, exports.relative_path, exports.finalized_at_ms
        FROM trace_exports AS exports
        JOIN trace_streams AS streams USING (trace_id)
        WHERE streams.state = 'exported' AND exports.finalized_at_ms IS NOT NULL
        ORDER BY exports.finalized_at_ms, exports.trace_id
      `)
      .all();
    const sizes = new Map<TraceId, number>();
    for (const row of rows) {
      assertSafeTracePath(row.relative_path);
      sizes.set(row.trace_id, fileSize(join(this.#traceDir, row.relative_path)));
    }

    const deletions = new Set<TraceId>();
    const cutoffMs = nowMs - this.#retentionMs;
    for (const row of rows) {
      if (row.finalized_at_ms <= cutoffMs) {
        deletions.add(row.trace_id);
      }
    }
    let retainedBytes = rows.reduce(
      (total, row) => total + (deletions.has(row.trace_id) ? 0 : (sizes.get(row.trace_id) ?? 0)),
      0,
    );
    for (const row of rows) {
      if (retainedBytes <= this.#maximumBytes) {
        break;
      }
      if (deletions.has(row.trace_id)) {
        continue;
      }
      deletions.add(row.trace_id);
      retainedBytes -= sizes.get(row.trace_id) ?? 0;
    }

    const transaction = this.#db.transaction(() => {
      const remove = this.#db.prepare<{ trace_id: string }>(
        "DELETE FROM trace_streams WHERE trace_id = @trace_id AND state = 'exported'",
      );
      for (const traceId of deletions) {
        remove.run({ trace_id: traceId });
      }
    });
    transaction.immediate();

    for (const row of rows) {
      if (deletions.has(row.trace_id)) {
        removeFile(join(this.#traceDir, row.relative_path));
      }
    }
    const knownPaths = new Set(
      this.#db
        .prepare<[], { relative_path: string }>("SELECT relative_path FROM trace_exports")
        .all()
        .map((row) => row.relative_path),
    );
    const deletedOrphanFiles = this.#deleteOrphanFiles(knownPaths);
    return {
      deletedTraceIds: [...deletions],
      deletedOrphanFiles,
      retainedBytes,
    };
  }

  #deleteOrphanFiles(knownPaths: ReadonlySet<string>): number {
    if (!existsSync(this.#traceDir)) {
      return 0;
    }
    let deleted = 0;
    for (const entry of readdirSync(this.#traceDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^tr_[a-f0-9]{32}\.jsonl$/u.test(entry.name) &&
        !knownPaths.has(entry.name)
      ) {
        removeFile(join(this.#traceDir, entry.name));
        deleted += 1;
      }
    }
    return deleted;
  }
}

function assertSafeTracePath(relativePath: string): void {
  if (
    basename(relativePath) !== relativePath ||
    !/^tr_[a-f0-9]{32}\.jsonl$/u.test(relativePath)
  ) {
    throw new Error(`Unsafe trace retention path: ${relativePath}`);
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if (isMissingFile(error)) {
      return 0;
    }
    throw error;
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}
