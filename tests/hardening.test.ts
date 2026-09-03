import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunStore } from "../src/agent/store.js";
import { compactDatabase } from "../src/db/database.js";
import { runCli, type CliIo } from "../src/cli.js";
import { newInboundId, newTraceId } from "../src/core/ids.js";
import { buildSafeReplay, renderSafeReplay } from "../src/replay.js";
import { TraceProjector } from "../src/tracing/jsonl.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceRetentionService, emergencyTrimTraceFiles } from "../src/tracing/retention.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe("safe replay", () => {
  it("reconstructs captured write-tool outcomes without provider or credential access", () => {
    const database = trackedDatabase();
    const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
    const runs = new AgentRunStore(database.handle.db, traces);
    const inbound = insertInbound(database, traces, "Send the existing draft");
    const run = runs.startOrResume({ source: { kind: "inbound", inboundId: inbound.inboundId }, traceId: inbound.traceId, deadlineAtMs: Date.now() + 60_000 });
    runs.appendInitialMessages(run.id, [
      { role: "system", content: "fixture system" },
      { role: "user", content: "Send the existing draft" },
    ]);
    runs.appendAssistant(run.id, {
      id: "response_tool",
      content: "",
      providerState: "The user asked for the send.",
      toolCalls: [
        {
          id: "call_send",
          name: "gmail.send_draft",
          argumentsJson: '{"draftId":"draft_1","account":"Work"}',
        },
      ],
      finishReason: "tool_calls",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const tool = runs.prepareTool({
      runId: run.id,
      call: {
        id: "call_send",
        name: "gmail.send_draft",
        argumentsJson: '{"draftId":"draft_1","account":"Work"}',
      },
      operationClass: "write",
      maximumToolCalls: 8,
    });
    runs.markToolRunning(tool.id);
    runs.finishTool(tool.id, "succeeded", {
      ok: true,
      account: { label: "Work" },
      message: { id: "message_1" },
    });
    runs.appendToolMessage(run.id, "call_send", '{"ok":true}');
    runs.appendAssistant(run.id, {
      id: "response_final",
      content: "Sent.",
      providerState: null,
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    runs.complete(run.id, "Sent.");
    const changesBefore = database.handle.db
      .prepare<[], { count: number }>("SELECT total_changes() AS count")
      .get()?.count;

    const replay = buildSafeReplay(database.handle.db, inbound.traceId);

    expect(replay).toMatchObject({
      mode: "mock_only",
      traceId: inbound.traceId,
      runId: run.id,
      providerCallsMade: 0,
      credentialDecryptions: 0,
      finalResponse: "Sent.",
    });
    expect(replay.mockedTools).toEqual([
      expect.objectContaining({
        toolCallId: "call_send",
        toolName: "gmail.send_draft",
        operationClass: "write",
        status: "succeeded",
        result: {
          ok: true,
          account: { label: "Work" },
          message: { id: "message_1" },
        },
      }),
    ]);
    expect(renderSafeReplay(replay)).toContain("mode=mock_only provider_calls=0 credential_decryptions=0");
    expect(
      database.handle.db.prepare<[], { count: number }>("SELECT total_changes() AS count").get()
        ?.count,
    ).toBe(changesBefore);
  });

  it("runs replay with storage configuration only and rejects malformed trace IDs", () => {
    const database = trackedDatabase();
    const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
    const runs = new AgentRunStore(database.handle.db, traces);
    const inbound = insertInbound(database, traces, "No tools");
    const run = runs.startOrResume({ source: { kind: "inbound", inboundId: inbound.inboundId }, traceId: inbound.traceId, deadlineAtMs: Date.now() + 60_000 });
    runs.appendInitialMessages(run.id, [{ role: "user", content: "No tools" }]);
    runs.complete(run.id, "Done");
    const output = captureIo();

    expect(runCli(["replay", inbound.traceId], storageEnv(database), output.io)).toBe(0);
    expect(output.stdout.join("")).toContain("provider_calls=0 credential_decryptions=0");
    expect(runCli(["replay", "../../credentials"], storageEnv(database), output.io)).toBe(1);
    expect(output.stderr.join("")).toContain("Invalid trace ID");
  });
});

describe("trace operations", () => {
  it("has the trace CLI identify the last recorded failure", () => {
    const database = trackedDatabase();
    const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
    const traceId = newTraceId();
    traces.append({
      traceId,
      component: "agent",
      event: "run_started",
      outcome: "running",
      data: {},
    });
    traces.append({
      traceId,
      component: "agent",
      event: "failed",
      outcome: "model_request_limit",
      data: { explanation: "The model request limit was reached" },
    });
    traces.markTerminal(traceId);
    const projector = new TraceProjector(database.handle.db, traces, database.config.traceDir);
    projector.project(traceId);
    const output = captureIo();

    expect(runCli(["trace", traceId], storageEnv(database), output.io)).toBe(0);
    expect(output.stdout.join("")).toContain(
      "Result: failure at sequence 2: agent.failed [model_request_limit]",
    );
    expect(output.stdout.join("")).toContain("The model request limit was reached");
  });

  it("deletes only exported terminal traces by age and total-byte pressure", () => {
    const database = trackedDatabase();
    const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
    const projector = new TraceProjector(database.handle.db, traces, database.config.traceDir);
    const now = Date.now();
    const old = exportedTrace(traces, projector, "old", 128);
    const pressure = exportedTrace(traces, projector, "pressure", 256);
    const retained = exportedTrace(traces, projector, "retained", 384);
    const open = newTraceId();
    traces.append({ traceId: open, component: "test", event: "open", data: {} });
    projector.project(open);
    database.handle.db
      .prepare<{ trace_id: string; finalized_at_ms: number }>(`
        UPDATE trace_exports SET finalized_at_ms = @finalized_at_ms WHERE trace_id = @trace_id
      `)
      .run({ trace_id: old, finalized_at_ms: now - 31 * 24 * 60 * 60 * 1_000 });
    database.handle.db
      .prepare<{ trace_id: string; finalized_at_ms: number }>(`
        UPDATE trace_exports SET finalized_at_ms = @finalized_at_ms WHERE trace_id = @trace_id
      `)
      .run({ trace_id: pressure, finalized_at_ms: now - 2_000 });
    database.handle.db
      .prepare<{ trace_id: string; finalized_at_ms: number }>(`
        UPDATE trace_exports SET finalized_at_ms = @finalized_at_ms WHERE trace_id = @trace_id
      `)
      .run({ trace_id: retained, finalized_at_ms: now - 1_000 });
    const retainedPath = join(database.config.traceDir, `${retained}.jsonl`);
    const maximumBytes = statSync(retainedPath).size;
    const orphanId = newTraceId();
    const orphanPath = join(database.config.traceDir, `${orphanId}.jsonl`);
    writeFileSync(orphanPath, "orphan\n", { mode: 0o600 });
    const retention = new TraceRetentionService({
      db: database.handle.db,
      traceDir: database.config.traceDir,
      retentionDays: 30,
      maximumBytes,
    });

    const result = retention.cleanup(now);
    expect(result.deletedTraceIds).toEqual([old, pressure]);
    expect(result.deletedOrphanFiles).toBe(1);
    expect(result.retainedBytes).toBe(maximumBytes);
    expect(traceExists(database, old)).toBe(false);
    expect(traceExists(database, pressure)).toBe(false);
    expect(traceExists(database, retained)).toBe(true);
    expect(traceExists(database, open)).toBe(true);
  });

  it("emergency-trims oldest trace files and crash-leftover temp files without the database", () => {
    const database = trackedDatabase();
    const traceDir = database.config.traceDir;
    mkdirSync(traceDir, { recursive: true });
    const oldest = `${newTraceId()}.jsonl`;
    const middle = `${newTraceId()}.jsonl`;
    const newest = `${newTraceId()}.jsonl`;
    for (const name of [oldest, middle, newest]) {
      writeFileSync(join(traceDir, name), "0".repeat(2_048), { mode: 0o600 });
    }
    const base = Date.now() / 1_000;
    utimesSync(join(traceDir, oldest), base - 3_000, base - 3_000);
    utimesSync(join(traceDir, middle), base - 2_000, base - 2_000);
    utimesSync(join(traceDir, newest), base - 1_000, base - 1_000);
    const tempName = `${newTraceId()}.jsonl.${randomUUID()}.tmp`;
    writeFileSync(join(traceDir, tempName), "partial", { mode: 0o600 });
    const unrelated = join(traceDir, "notes.txt");
    writeFileSync(unrelated, "keep", { mode: 0o600 });

    const result = emergencyTrimTraceFiles({ traceDir, maximumBytes: 3_000 });

    expect(result.deletedTraceFiles).toBe(2);
    expect(result.deletedOrphanFiles).toBe(1);
    expect(result.retainedBytes).toBe(2_048);
    expect(existsSync(join(traceDir, oldest))).toBe(false);
    expect(existsSync(join(traceDir, middle))).toBe(false);
    expect(existsSync(join(traceDir, newest))).toBe(true);
    expect(existsSync(join(traceDir, tempName))).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("deletes crash-leftover temporary projection files as orphans during retention", () => {
    const database = trackedDatabase();
    const traceDir = database.config.traceDir;
    mkdirSync(traceDir, { recursive: true });
    const tempPath = join(traceDir, `${newTraceId()}.jsonl.${randomUUID()}.tmp`);
    writeFileSync(tempPath, "partial\n", { mode: 0o600 });
    const retention = new TraceRetentionService({
      db: database.handle.db,
      traceDir,
      retentionDays: 30,
      maximumBytes: 1_073_741_824,
    });

    const result = retention.cleanup();

    expect(result.deletedOrphanFiles).toBe(1);
    expect(existsSync(tempPath)).toBe(false);
  });

  it("deletes aged trace rows whose projected file is already gone", () => {
    const database = trackedDatabase();
    const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
    const projector = new TraceProjector(database.handle.db, traces, database.config.traceDir);
    const now = Date.now();
    const aged = exportedTrace(traces, projector, "aged", 128);
    database.handle.db
      .prepare<{ trace_id: string; finalized_at_ms: number }>(`
        UPDATE trace_exports SET finalized_at_ms = @finalized_at_ms WHERE trace_id = @trace_id
      `)
      .run({ trace_id: aged, finalized_at_ms: now - 31 * 24 * 60 * 60 * 1_000 });
    rmSync(join(database.config.traceDir, `${aged}.jsonl`));
    const retention = new TraceRetentionService({
      db: database.handle.db,
      traceDir: database.config.traceDir,
      retentionDays: 30,
      maximumBytes: 536_870_912,
    });

    const result = retention.cleanup(now);

    expect(result.deletedTraceIds).toEqual([aged]);
    expect(traceExists(database, aged)).toBe(false);
  });

  it("reclaims SQLite file space after retention frees large spool ranges", () => {
    const database = trackedDatabase();
    expect(compactDatabase(database.handle.db)).toBe(false);
    const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
    const projector = new TraceProjector(database.handle.db, traces, database.config.traceDir);
    const now = Date.now();
    const aged = newTraceId();
    for (let index = 0; index < 128; index += 1) {
      traces.append({
        traceId: aged,
        component: "fixture",
        event: "bulk",
        data: { payload: "x".repeat(4_000) },
      });
    }
    traces.markTerminal(aged);
    projector.project(aged);
    database.handle.db
      .prepare<{ trace_id: string; finalized_at_ms: number }>(`
        UPDATE trace_exports SET finalized_at_ms = @finalized_at_ms WHERE trace_id = @trace_id
      `)
      .run({ trace_id: aged, finalized_at_ms: now - 31 * 24 * 60 * 60 * 1_000 });
    const retention = new TraceRetentionService({
      db: database.handle.db,
      traceDir: database.config.traceDir,
      retentionDays: 30,
      maximumBytes: 536_870_912,
    });
    retention.cleanup(now);
    database.handle.db.pragma("wal_checkpoint(TRUNCATE)");
    const sizeBefore = statSync(database.config.databasePath).size;

    expect(compactDatabase(database.handle.db, 65_536)).toBe(true);

    const sizeAfter = statSync(database.config.databasePath).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);
    expect(compactDatabase(database.handle.db, 65_536)).toBe(false);
  });
});

function trackedDatabase(): TestDatabase {
  const database = createTestDatabase();
  databases.push(database);
  return database;
}

function insertInbound(database: TestDatabase, traces: TraceStore, text: string) {
  const inboundId = newInboundId();
  const traceId = newTraceId();
  const deliveryId = `delivery_${randomUUID()}`;
  const now = Date.now();
  traces.append({ traceId, component: "test", event: "accepted", data: {} });
  const transaction = database.handle.db.transaction(() => {
    database.handle.db
      .prepare(`
        INSERT INTO webhook_deliveries(
          id, provider_delivery_id, provider_message_id, event_kind, line_id,
          line_handle, outbox_id, normalized_json, trace_id, received_at_ms
        ) VALUES (?, ?, ?, 'message.received', 'line_test', '+15551110000', NULL, '{}', ?, ?)
      `)
      .run(deliveryId, deliveryId, deliveryId, traceId, now);
    database.handle.db
      .prepare(`
        INSERT INTO inbound_messages(
          id, delivery_id, provider_message_id, chat_id, guid, sender,
          line_id, line_handle, sequence, state, text, is_audio,
          attachment_json, trace_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'chat_test', ?, '+15559990000',
                  'line_test', '+15551110000', 1, 'ready', ?, 0,
                  NULL, ?, ?, ?)
      `)
      .run(inboundId, deliveryId, deliveryId, deliveryId, text, traceId, now, now);
  });
  transaction.immediate();
  return { inboundId, traceId };
}

function exportedTrace(
  traces: TraceStore,
  projector: TraceProjector,
  outcome: string,
  payloadBytes: number,
) {
  const traceId = newTraceId();
  traces.append({
    traceId,
    component: "fixture",
    event: "completed",
    outcome,
    data: { payload: "x".repeat(payloadBytes) },
  });
  traces.markTerminal(traceId);
  projector.project(traceId);
  return traceId;
}

function traceExists(database: TestDatabase, traceId: string): boolean {
  return (
    database.handle.db
      .prepare<{ trace_id: string }, { present: number }>(
        "SELECT 1 AS present FROM trace_streams WHERE trace_id = @trace_id",
      )
      .get({ trace_id: traceId }) !== undefined
  );
}

function storageEnv(database: TestDatabase): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATA_DIR: database.config.dataDir,
    DATABASE_PATH: database.config.databasePath,
    MEMORY_PATH: database.config.memoryPath,
    TRACE_DIR: database.config.traceDir,
  };
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}
