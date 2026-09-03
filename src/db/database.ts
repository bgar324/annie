import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeSync, fsyncSync, accessSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { StorageConfig } from "../config.js";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "./migrations.js";

export interface DatabaseHealth {
  writable: boolean;
  journalMode: "wal" | "memory";
  synchronous: 2;
  foreignKeys: 1;
  schemaVersion: number;
  integrity: "ok";
}

export interface DatabaseHandle {
  db: Database.Database;
  health(): DatabaseHealth;
  close(): void;
}

export function openDatabase(config: StorageConfig): DatabaseHandle {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(dirname(config.databasePath), { recursive: true });
  assertWritableDirectory(config.dataDir);

  const db = new Database(config.databasePath, { timeout: 5_000 });
  try {
    const requestedJournal = String(db.pragma("journal_mode = WAL", { simple: true })).toLowerCase();
    const isMemory = config.databasePath === ":memory:";
    if (requestedJournal !== "wal" && !(isMemory && requestedJournal === "memory")) {
      throw new Error(`SQLite WAL mode is unavailable: ${requestedJournal}`);
    }

    db.pragma("synchronous = FULL");
    db.pragma("journal_size_limit = 67108864");
    db.pragma("foreign_keys = ON");

    if (Number(db.pragma("synchronous", { simple: true })) !== 2) {
      throw new Error("SQLite synchronous=FULL was not applied");
    }
    if (Number(db.pragma("foreign_keys", { simple: true })) !== 1) {
      throw new Error("SQLite foreign keys are disabled");
    }

    runMigrations(db);
    assertDatabaseIntegrity(db);
  } catch (error) {
    db.close();
    throw error;
  }

  let closed = false;
  return {
    db,
    health(): DatabaseHealth {
      if (closed || !db.open) {
        throw new Error("SQLite is closed");
      }
      assertWritableDirectory(config.dataDir);
      assertDatabaseIntegrity(db);
      const journalMode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
      if (journalMode !== "wal" && journalMode !== "memory") {
        throw new Error(`Unexpected SQLite journal mode: ${journalMode}`);
      }
      const schemaVersion = currentSchemaVersion(db);
      if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`Expected schema ${CURRENT_SCHEMA_VERSION}, found ${schemaVersion}`);
      }
      return {
        writable: true,
        journalMode,
        synchronous: 2,
        foreignKeys: 1,
        schemaVersion,
        integrity: "ok",
      };
    },
    close(): void {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}

function currentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare<[], { version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get();
  if (row === undefined) {
    throw new Error("schema_migrations returned no row");
  }
  return row.version;
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const result = String(db.pragma("quick_check", { simple: true }));
  if (result !== "ok") {
    throw new Error(`SQLite quick_check failed: ${result}`);
  }
}

/**
 * Reclaims SQLite file space after retention deleted large row ranges. The
 * database file never shrinks on its own, so a volume that once filled stays
 * filled even after cleanup. Gated on free-page bytes so steady-state boots
 * pay nothing.
 */
export function compactDatabase(
  db: Database.Database,
  minimumFreeBytes = 67_108_864,
): boolean {
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const freeListCount = Number(db.pragma("freelist_count", { simple: true }));
  if (!Number.isSafeInteger(pageSize) || !Number.isSafeInteger(freeListCount)) {
    return false;
  }
  if (pageSize * freeListCount < minimumFreeBytes) {
    return false;
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  return true;
}

function assertWritableDirectory(directory: string): void {
  accessSync(directory, constants.W_OK);
  const probePath = join(directory, `.write-probe-${process.pid}-${Date.now()}`);
  const descriptor = openSync(probePath, "wx", 0o600);
  try {
    writeSync(descriptor, "ok");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
    unlinkSync(probePath);
  }
}
