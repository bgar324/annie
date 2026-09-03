import { createHash, randomUUID } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryMaintenanceModel,
  MemoryMaintenanceRequest,
} from "../src/agent/model.js";
import { AgentRunStore } from "../src/agent/store.js";
import {
  newInboundId,
  newTraceId,
  type InboundId,
  type RunId,
  type TraceId,
} from "../src/core/ids.js";
import { MemoryDocumentStore } from "../src/memory/document.js";
import { MemoryMaintenanceService } from "../src/memory/maintenance.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe("canonical memory document", () => {
  it("creates, atomically replaces, and repairs the canonical file", async () => {
    const database = trackedDatabase();
    const store = new MemoryDocumentStore({
      path: database.config.memoryPath,
      maximumBytes: 16_384,
    });

    await expect(store.repairAndLoad()).resolves.toBe("# Memory\n");
    const before = await store.loadSnapshot();
    await expect(
      store.replaceIfRevision(
        before.revision,
        store.prepareReplacement("# Memory\r\n\r\n## User\r\n- Likes tea  "),
      ),
    ).resolves.toMatchObject({
      kind: "replaced",
      snapshot: { content: "# Memory\n\n## User\n- Likes tea\n" },
    });
    await writeFile(`${database.config.memoryPath}.tmp-stale`, "partial", "utf8");
    await expect(store.repairAndLoad()).resolves.toBe("# Memory\n\n## User\n- Likes tea\n");
    expect(
      (await readdir(database.directory)).filter((name) => name.startsWith("MEMORY.md.tmp-")),
    ).toEqual([]);

    await rm(database.config.memoryPath);
    await writeFile(
      `${database.config.memoryPath}.tmp-recoverable`,
      "# Memory\n\n## User\n- Recovered fact\n",
      "utf8",
    );
    await expect(store.repairAndLoad()).resolves.toBe(
      "# Memory\n\n## User\n- Recovered fact\n",
    );
  });

  it("serializes revision-checked replacements so only one stale writer wins", async () => {
    const database = trackedDatabase();
    const store = new MemoryDocumentStore({
      path: database.config.memoryPath,
      maximumBytes: 16_384,
    });
    await store.repairAndLoad();
    const before = await store.loadSnapshot();

    const [first, second] = await Promise.all([
      store.replaceIfRevision(
        before.revision,
        store.prepareReplacement("# Memory\n\n- First writer\n"),
      ),
      store.replaceIfRevision(
        before.revision,
        store.prepareReplacement("# Memory\n\n- Second writer\n"),
      ),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["conflict", "replaced"]);
    const current = await store.loadSnapshot();
    expect(current.revision).not.toBe(before.revision);
    expect(["# Memory\n\n- First writer\n", "# Memory\n\n- Second writer\n"]).toContain(
      current.content,
    );
  });

  it("does not begin a queued replacement after its abort signal fires", async () => {
    const database = trackedDatabase();
    const store = new MemoryDocumentStore({
      path: database.config.memoryPath,
      maximumBytes: 16_384,
    });
    await store.repairAndLoad();
    const before = await store.loadSnapshot();
    const controller = new AbortController();

    const replacing = store.replaceIfRevision(
      before.revision,
      store.prepareReplacement("# Memory\n\n- Too late\n"),
      controller.signal,
    );
    controller.abort();

    await expect(replacing).rejects.toMatchObject({ name: "AbortError" });
    await expect(store.loadSnapshot()).resolves.toEqual(before);
  });

  it("rejects oversized or secret-bearing replacements without truncating memory", async () => {
    const database = trackedDatabase();
    const secret = "deepseek-secret-value";
    const store = new MemoryDocumentStore({
      path: database.config.memoryPath,
      maximumBytes: 16_384,
      forbiddenValues: [secret],
    });
    await store.repairAndLoad();
    await replaceMemory(store, "# Memory\n\n- Stable fact\n");

    await expect(replaceMemory(store, `# Memory\n${"x".repeat(16_384)}`)).rejects.toMatchObject(
      {
        code: "too_large",
      },
    );
    await expect(replaceMemory(store, `# Memory\n\n- ${secret}\n`)).rejects.toMatchObject({
      code: "forbidden_secret",
    });
    await expect(
      replaceMemory(
        store,
        "# Memory\n\n- https://assistant.example/connect/google?token=signed-value\n",
      ),
    ).rejects.toMatchObject({ code: "forbidden_secret" });
    await expect(store.load()).resolves.toBe("# Memory\n\n- Stable fact\n");
  });
});

describe("post-turn memory maintenance", () => {
  it("writes one complete replacement and traces its unified diff", async () => {
    const harness = await maintenanceHarness();
    const { runId, traceId } = completedRun(harness, "Remember that I like tea", 1);
    const requests: MemoryMaintenanceRequest[] = [];
    const model: MemoryMaintenanceModel = {
      async maintainMemory(request) {
        requests.push(request);
        return {
          id: "memory_response",
          content: JSON.stringify({
            action: "replace",
            memory: "# Memory\n\n## User\n- Likes tea\n",
          }),
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        };
      },
    };
    const service = new MemoryMaintenanceService({
      db: harness.database.handle.db,
      documents: harness.documents,
      model,
      traces: harness.traces,
    });
    harness.runs.appendToolMessage(
      runId,
      "tool_memory_fixture",
      JSON.stringify({ tool: "gmail.search", ok: true }),
    );

    const first = await service.maintainRun({
      runId,
      deadlineAtMs: Date.now() + 60_000,
    });
    const second = await service.maintainRun({
      runId,
      deadlineAtMs: Date.now() + 60_000,
    });

    expect(first).toEqual({
      status: "updated",
      memory: "# Memory\n\n## User\n- Likes tea\n",
    });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.content).toContain("at most 16384 UTF-8 bytes");
    expect(requests[0]?.messages[1]?.content).toContain("Remember that I like tea");
    expect(requests[0]?.messages[1]?.content).toContain("Reply remains available");
    expect(requests[0]?.messages[1]?.content).toContain("gmail.search");
    const run = harness.database.handle.db
      .prepare<{ id: string }, {
        maintenance_requests: number;
        memory_maintenance_status: string;
        memory_before_digest: string;
        memory_after_digest: string;
      }>(`
        SELECT maintenance_requests, memory_maintenance_status,
               memory_before_digest, memory_after_digest
        FROM agent_runs WHERE id = @id
      `)
      .get({ id: runId });
    expect(run).toMatchObject({
      maintenance_requests: 1,
      memory_maintenance_status: "updated",
    });
    expect(run?.memory_before_digest).not.toBe(run?.memory_after_digest);
    const memoryTrace = harness.traces
      .list(traceId)
      .find((event) => event.component === "memory" && event.event === "updated");
    expect(memoryTrace?.data).toMatchObject({
      beforeDigest: run?.memory_before_digest,
      afterDigest: run?.memory_after_digest,
      usage: { totalTokens: 30 },
    });
    expect(JSON.stringify(memoryTrace?.data)).toContain("+## User");
    expect(JSON.stringify(memoryTrace?.data)).toContain("+- Likes tea");
  });

  it("leaves memory unchanged when the model returns an oversized replacement", async () => {
    const harness = await maintenanceHarness();
    await replaceMemory(harness.documents, "# Memory\n\n- Keep this\n");
    const { runId, traceId } = completedRun(harness, "Store too much", 1);
    let requests = 0;
    const service = new MemoryMaintenanceService({
      db: harness.database.handle.db,
      documents: harness.documents,
      traces: harness.traces,
      model: {
        async maintainMemory() {
          requests += 1;
          return {
            id: "oversized",
            content: JSON.stringify({
              action: "replace",
              memory: `# Memory\n${"x".repeat(16_384)}`,
            }),
            usage: { promptTokens: null, completionTokens: null, totalTokens: null },
          };
        },
      },
    });

    await expect(
      service.maintainRun({
        runId,
        deadlineAtMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ status: "invalid", memory: "# Memory\n\n- Keep this\n" });
    expect(requests).toBe(1);
    await expect(harness.documents.load()).resolves.toBe("# Memory\n\n- Keep this\n");
    expect(runMaintenanceStatus(harness.database, runId)).toBe("invalid");
  });

  it("does not fail the completed turn when maintenance fails", async () => {
    const harness = await maintenanceHarness();
    const { runId, traceId } = completedRun(harness, "Do not break reply", 1);
    const service = new MemoryMaintenanceService({
      db: harness.database.handle.db,
      documents: harness.documents,
      traces: harness.traces,
      model: {
        async maintainMemory() {
          throw new Error("model unavailable");
        },
      },
    });

    await expect(
      service.maintainRun({
        runId,
        deadlineAtMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ status: "failed", memory: "# Memory\n" });
    expect(runMaintenanceStatus(harness.database, runId)).toBe("failed");
    expect(
      harness.database.handle.db
        .prepare<{ id: string }, { phase: string; final_response: string }>(`
          SELECT phase, final_response FROM agent_runs WHERE id = @id
        `)
        .get({ id: runId }),
    ).toEqual({ phase: "completed", final_response: "Reply remains available" });
  });

  it("does not overwrite a human edit completed while the model is running", async () => {
    const harness = await maintenanceHarness();
    const { runId, traceId } = completedRun(harness, "Remember the agent proposal", 1);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const service = new MemoryMaintenanceService({
      db: harness.database.handle.db,
      documents: harness.documents,
      traces: harness.traces,
      model: {
        async maintainMemory() {
          started.resolve();
          await release.promise;
          return {
            id: "stale-memory-proposal",
            content: JSON.stringify({
              action: "replace",
              memory: "# Memory\n\n- Agent proposal\n",
            }),
            usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
          };
        },
      },
    });

    const maintaining = service.maintainRun({
      runId,
      deadlineAtMs: Date.now() + 60_000,
    });
    await started.promise;
    const current = await harness.documents.loadSnapshot();
    await harness.documents.replaceIfRevision(
      current.revision,
      harness.documents.prepareReplacement("# Memory\n\n- Human edit\n"),
    );
    release.resolve();

    await expect(maintaining).resolves.toEqual({
      status: "failed",
      memory: "# Memory\n\n- Human edit\n",
    });
    await expect(harness.documents.load()).resolves.toBe("# Memory\n\n- Human edit\n");
    expect(runMaintenanceStatus(harness.database, runId)).toBe("failed");
    expect(
      harness.traces
        .list(traceId)
        .some(
          (event) =>
            event.component === "memory" &&
            event.event === "failed" &&
            event.outcome === "memory_changed",
        ),
    ).toBe(true);
  });

  it("records a failed maintenance boundary when the job deadline already elapsed", async () => {
    const harness = await maintenanceHarness();
    const { runId, traceId } = completedRun(harness, "Reply now", 1);
    let requests = 0;
    const service = new MemoryMaintenanceService({
      db: harness.database.handle.db,
      documents: harness.documents,
      traces: harness.traces,
      model: {
        async maintainMemory() {
          requests += 1;
          throw new Error("must not be called");
        },
      },
    });

    await expect(
      service.maintainRun({
        runId,
        deadlineAtMs: Date.now() - 1,
      }),
    ).resolves.toEqual({ status: "failed", memory: "# Memory\n" });
    expect(requests).toBe(0);
    expect(runMaintenanceStatus(harness.database, runId)).toBe("failed");
    expect(
      harness.traces
        .list(traceId)
        .some(
          (event) =>
            event.component === "memory" &&
            event.event === "failed" &&
            event.outcome === "deadline_exceeded",
        ),
    ).toBe(true);
  });

  it("durably fails maintenance when its remaining run signal expires", async () => {
    const harness = await maintenanceHarness();
    const { runId, traceId } = completedRun(harness, "Reply before timeout", 1);
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const service = new MemoryMaintenanceService({
      db: harness.database.handle.db,
      documents: harness.documents,
      traces: harness.traces,
      model: {
        async maintainMemory(request) {
          expect(request.signal).toBe(controller.signal);
          controller.abort();
          request.signal.throwIfAborted();
          throw new Error("unreachable");
        },
      },
    });
    try {
      await expect(
        service.maintainRun({
          runId,
          deadlineAtMs: Date.now() + 60_000,
        }),
      ).resolves.toEqual({ status: "failed", memory: "# Memory\n" });
      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout.mock.calls[0]?.[0]).toBeGreaterThan(0);
    } finally {
      timeout.mockRestore();
    }

    expect(runMaintenanceStatus(harness.database, runId)).toBe("failed");
    expect(
      harness.traces
        .list(traceId)
        .some(
          (event) =>
            event.component === "memory" &&
            event.event === "failed" &&
            event.outcome === "deadline_exceeded",
        ),
    ).toBe(true);
  });

  it("finalizes a prepared memory update when startup finds the renamed document", async () => {
    const harness = await maintenanceHarness();
    const { runId, traceId } = completedRun(harness, "Remember crash safety", 1);
    const before = await harness.documents.load();
    const after = "# Memory\n\n## User\n- Values crash safety\n";
    const prepared = prepareInterruptedMemoryUpdate(harness, runId, before, after);
    await replaceMemory(harness.documents, after);
    const service = recoveryService(harness);

    await expect(service.recoverInterrupted()).resolves.toBe(1);
    expect(runMaintenanceStatus(harness.database, runId)).toBe("updated");
    expect(
      harness.database.handle.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM memory_updates")
        .get()?.count,
    ).toBe(0);
    const event = harness.traces
      .list(traceId)
      .find((candidate) => candidate.component === "memory" && candidate.event === "updated");
    expect(event?.data).toMatchObject({
      beforeDigest: prepared.beforeDigest,
      afterDigest: prepared.afterDigest,
      diff: "prepared memory diff",
      usage: { totalTokens: 3 },
    });
  });

  it("fails a prepared memory update when the atomic rename never happened", async () => {
    const harness = await maintenanceHarness();
    const { runId, traceId } = completedRun(harness, "Do not invent a write", 1);
    const before = await harness.documents.load();
    prepareInterruptedMemoryUpdate(
      harness,
      runId,
      before,
      "# Memory\n\n## User\n- This rename never happened\n",
    );
    const service = recoveryService(harness);

    await expect(service.recoverInterrupted()).resolves.toBe(1);
    expect(runMaintenanceStatus(harness.database, runId)).toBe("failed");
    expect(
      harness.traces
        .list(traceId)
        .some(
          (event) =>
            event.component === "memory" &&
            event.event === "failed" &&
            event.outcome === "interrupted_before_replace",
        ),
    ).toBe(true);
    await expect(harness.documents.load()).resolves.toBe(before);
  });
});

interface MaintenanceHarness {
  database: TestDatabase;
  traces: TraceStore;
  runs: AgentRunStore;
  documents: MemoryDocumentStore;
}

async function maintenanceHarness(): Promise<MaintenanceHarness> {
  const database = trackedDatabase();
  const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
  const documents = new MemoryDocumentStore({
    path: database.config.memoryPath,
    maximumBytes: 16_384,
  });
  await documents.repairAndLoad();
  return {
    database,
    traces,
    runs: new AgentRunStore(database.handle.db, traces),
    documents,
  };
}

async function replaceMemory(documents: MemoryDocumentStore, content: string): Promise<void> {
  const current = await documents.loadSnapshot();
  const result = await documents.replaceIfRevision(
    current.revision,
    documents.prepareReplacement(content),
  );
  if (result.kind === "conflict") {
    throw new Error("Memory test fixture lost its revision");
  }
}

function completedRun(
  harness: MaintenanceHarness,
  userMessage: string,
  sequence: number,
): { runId: RunId; traceId: TraceId } {
  const { inboundId, traceId } = insertInbound(harness.database, harness.traces, userMessage, sequence);
  const run = harness.runs.startOrResume({ source: { kind: "inbound", inboundId }, traceId, deadlineAtMs: Date.now() + 60_000 });
  harness.runs.appendInitialMessages(run.id, [
    { role: "system", content: "memory fixture" },
    { role: "user", content: userMessage },
  ]);
  harness.runs.complete(run.id, "Reply remains available");
  return { runId: run.id, traceId };
}

function insertInbound(
  database: TestDatabase,
  traces: TraceStore,
  text: string,
  sequence: number,
): { inboundId: InboundId; traceId: TraceId } {
  const inboundId = newInboundId();
  const traceId = newTraceId();
  const deliveryId = `delivery_${randomUUID()}`;
  const providerMessageId = `message_${randomUUID()}`;
  const now = Date.now();
  traces.append({
    traceId,
    component: "test",
    event: "inbound_fixture",
    outcome: "ready",
    data: {},
  });
  const transaction = database.handle.db.transaction(() => {
    database.handle.db
      .prepare(`
        INSERT INTO webhook_deliveries(
          id, provider_delivery_id, provider_message_id, event_kind, line_id,
          line_handle, outbox_id, normalized_json, trace_id, received_at_ms
        ) VALUES (?, ?, ?, 'message.created', 'line_test', '+15551110000', NULL, '{}', ?, ?)
      `)
      .run(deliveryId, deliveryId, providerMessageId, traceId, now);
    database.handle.db
      .prepare(`
        INSERT INTO inbound_messages(
          id, delivery_id, provider_message_id, chat_id, guid, sender,
          line_id, line_handle, sequence, state, text, is_audio,
          attachment_json, trace_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'chat_test', ?, '+15559990000',
                  'line_test', '+15551110000', ?, 'ready', ?, 0,
                  NULL, ?, ?, ?)
      `)
      .run(
        inboundId,
        deliveryId,
        providerMessageId,
        providerMessageId,
        sequence,
        text,
        traceId,
        now,
        now,
      );
  });
  transaction.immediate();
  return { inboundId, traceId };
}

function runMaintenanceStatus(database: TestDatabase, runId: string): string | undefined {
  return database.handle.db
    .prepare<{ id: string }, { memory_maintenance_status: string }>(`
      SELECT memory_maintenance_status FROM agent_runs WHERE id = @id
    `)
    .get({ id: runId })?.memory_maintenance_status;
}


function prepareInterruptedMemoryUpdate(
  harness: MaintenanceHarness,
  runId: RunId,
  before: string,
  after: string,
): { beforeDigest: string; afterDigest: string } {
  const beforeDigest = createHash("sha256").update(before).digest("hex");
  const afterDigest = createHash("sha256").update(after).digest("hex");
  const transaction = harness.database.handle.db.transaction(() => {
    harness.database.handle.db
      .prepare<{ id: string; before_digest: string; now_ms: number }>(`
        UPDATE agent_runs
        SET memory_maintenance_status = 'attempting',
            memory_before_digest = @before_digest,
            maintenance_requests = maintenance_requests + 1,
            updated_at_ms = @now_ms
        WHERE id = @id
      `)
      .run({ id: runId, before_digest: beforeDigest, now_ms: Date.now() });
    harness.database.handle.db
      .prepare<{
        run_id: string;
        before_digest: string;
        after_digest: string;
        usage_json: string;
        now_ms: number;
      }>(`
        INSERT INTO memory_updates(
          run_id, before_digest, after_digest, diff, usage_json, created_at_ms
        ) VALUES (
          @run_id, @before_digest, @after_digest, 'prepared memory diff', @usage_json, @now_ms
        )
      `)
      .run({
        run_id: runId,
        before_digest: beforeDigest,
        after_digest: afterDigest,
        usage_json: JSON.stringify({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
        now_ms: Date.now(),
      });
  });
  transaction.immediate();
  return { beforeDigest, afterDigest };
}

function recoveryService(harness: MaintenanceHarness): MemoryMaintenanceService {
  return new MemoryMaintenanceService({
    db: harness.database.handle.db,
    documents: harness.documents,
    traces: harness.traces,
    model: {
      async maintainMemory() {
        throw new Error("Recovery must not call the model");
      },
    },
  });
}
function trackedDatabase(): TestDatabase {
  const database = createTestDatabase();
  databases.push(database);
  return database;
}
