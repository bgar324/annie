import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/database.js";

export interface TestDatabase {
  directory: string;
  config: StorageConfig;
  handle: DatabaseHandle;
  cleanup(): void;
}

export function createTestDatabase(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), "imessage-assistant-test-"));
  const config: StorageConfig = {
    nodeEnv: "test",
    dataDir: directory,
    databasePath: join(directory, "assistant.sqlite"),
    memoryPath: join(directory, "MEMORY.md"),
    traceDir: join(directory, "traces"),
    traceRetentionDays: 30,
    traceMaxBytes: 16_777_216,
  };
  const handle = openDatabase(config);
  return {
    directory,
    config,
    handle,
    cleanup(): void {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
