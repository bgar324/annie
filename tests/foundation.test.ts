import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.js";
import { newTraceId } from "../src/core/ids.js";
import { openDatabase } from "../src/db/database.js";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "../src/db/migrations.js";
import { TraceProjector } from "../src/tracing/jsonl.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { renderTrace } from "../src/tracing/render.js";
import { TraceStore } from "../src/tracing/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.cleanup();
  testDatabase = undefined;
});

function validEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATA_DIR: directory,
    SENDBLUE_API_KEY_ID: "sendblue_test_key_id",
    SENDBLUE_API_SECRET_KEY: "sendblue_test_secret_key",
    SENDBLUE_FROM_NUMBER: "+15550000001",
    SENDBLUE_BASE_URL: "https://api.sendblue.co",
    USER_PHONE_NUMBER: "+15550000002",
    PUBLIC_BASE_URL: "http://localhost:3000",
    GEMINI_API_KEY: "gemini_test_key",
    GOOGLE_CLIENT_ID: "google_test_client",
    GOOGLE_CLIENT_SECRET: "google_test_secret",
    GOOGLE_WORKSPACE_SCOPES: "openid,email,https://www.googleapis.com/auth/gmail.readonly",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

describe("runtime configuration", () => {
  it("derives fixed callbacks and storage paths from validated input", () => {
    testDatabase = createTestDatabase();
    const config = loadRuntimeConfig(validEnvironment(testDatabase.directory));

    expect(config.google.callbackUrl).toBe("http://localhost:3000/oauth/google/callback");
    expect(config.notion.callbackUrl).toBe("http://localhost:3000/oauth/notion/callback");
    expect(config.google.scopes).toEqual([
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "openid",
    ]);
    expect(config.credentialEncryptionKey).toHaveLength(32);
    expect(config.sendblue).toEqual({
      apiKeyId: "sendblue_test_key_id",
      apiSecretKey: "sendblue_test_secret_key",
      fromNumber: "+15550000001",
      baseUrl: "https://api.sendblue.co",
    });
    expect(config.gemini).toEqual({
      apiKey: "gemini_test_key",
      model: "gemini-3.7-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      reasoningEffort: "low",
    });
    expect(config.dailyBrief).toEqual({
      enabled: false,
      timeZone: "America/Los_Angeles",
    });
    expect(config.userPhoneNumber).toBe("+15550000002");
    expect(config.databasePath).toBe(join(testDatabase.directory, "assistant.sqlite"));
  });

  it("fails closed for incomplete identity scopes, unusable numbers, and production storage", () => {
    testDatabase = createTestDatabase();
    const missingScope = validEnvironment(testDatabase.directory);
    missingScope.GOOGLE_WORKSPACE_SCOPES = "openid";
    expect(() => loadRuntimeConfig(missingScope)).toThrow(/must include email/u);

    const localFromNumber = validEnvironment(testDatabase.directory);
    localFromNumber.SENDBLUE_FROM_NUMBER = "5550000001";
    expect(() => loadRuntimeConfig(localFromNumber)).toThrow();

    const localUserNumber = validEnvironment(testDatabase.directory);
    localUserNumber.USER_PHONE_NUMBER = "(555) 000-0002";
    expect(() => loadRuntimeConfig(localUserNumber)).toThrow();

    const missingSecret = validEnvironment(testDatabase.directory);
    delete missingSecret.SENDBLUE_API_SECRET_KEY;
    expect(() => loadRuntimeConfig(missingSecret)).toThrow();

    const alternateTimeZone = validEnvironment(testDatabase.directory);
    alternateTimeZone.DAILY_BRIEF_TIME_ZONE = "America/New_York";
    expect(loadRuntimeConfig(alternateTimeZone).dailyBrief.timeZone).toBe(
      "America/Los_Angeles",
    );

    const enabledBrief = validEnvironment(testDatabase.directory);
    enabledBrief.DAILY_BRIEF_ENABLED = "true";
    expect(loadRuntimeConfig(enabledBrief).dailyBrief.enabled).toBe(true);

    const noVolume = validEnvironment(testDatabase.directory);
    noVolume.NODE_ENV = "production";
    noVolume.PUBLIC_BASE_URL = "https://assistant.example.com";
    delete noVolume.RAILWAY_VOLUME_MOUNT_PATH;
    expect(() => loadRuntimeConfig(noVolume)).toThrow(/RAILWAY_VOLUME_MOUNT_PATH/u);
  });

  it("requires credential-bearing provider URLs to use HTTPS in production", () => {
    testDatabase = createTestDatabase();
    const environment = validEnvironment(testDatabase.directory);
    environment.NODE_ENV = "production";
    environment.PUBLIC_BASE_URL = "https://assistant.example.com";
    environment.RAILWAY_VOLUME_MOUNT_PATH = testDatabase.directory;
    environment.DATA_DIR = testDatabase.directory;
    environment.SENDBLUE_BASE_URL = "http://sendblue.example.test";

    expect(() => loadRuntimeConfig(environment)).toThrow(
      /SENDBLUE_BASE_URL must use HTTPS in production/u,
    );

    const geminiEnvironment = validEnvironment(testDatabase.directory);
    geminiEnvironment.NODE_ENV = "production";
    geminiEnvironment.PUBLIC_BASE_URL = "https://assistant.example.com";
    geminiEnvironment.RAILWAY_VOLUME_MOUNT_PATH = testDatabase.directory;
    geminiEnvironment.DATA_DIR = testDatabase.directory;
    geminiEnvironment.GEMINI_BASE_URL = "http://gemini.example.test";

    expect(() => loadRuntimeConfig(geminiEnvironment)).toThrow(
      /GEMINI_BASE_URL must use HTTPS in production/u,
    );
  });
});

describe("SQLite foundation", () => {
  it("migrates once and reports the required durability pragmas", () => {
    testDatabase = createTestDatabase();
    const health = testDatabase.handle.health();
    expect(health).toMatchObject({
      journalMode: "wal",
      synchronous: 2,
      foreignKeys: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      integrity: "ok",
    });

    testDatabase.handle.close();
    const reopened = openDatabase(testDatabase.config);
    testDatabase.handle = reopened;
    expect(reopened.health().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const tables = reopened.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toContain("write_intents");
    expect(tables).toContain("sendblue_ingress_cursor");
    expect(tables).toContain("trace_event_spool");
    expect(tables).toContain("oauth_attempts");
  });

  it("preserves queued work and run children while adding scheduled run sources", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, 4);
    db.exec(`
      INSERT INTO webhook_deliveries(
        id, provider_delivery_id, provider_message_id, event_kind, line_id,
        line_handle, outbox_id, normalized_json, trace_id, received_at_ms
      ) VALUES (
        'delivery_existing', 'provider_delivery_existing', 'provider_message_existing',
        'message.received', 'line_existing', '+15550000001', NULL, '{}',
        'trace_existing', 1
      );
      INSERT INTO inbound_messages(
        id, delivery_id, provider_message_id, chat_id, guid, sender, line_id,
        line_handle, sequence, state, text, is_audio, attachment_json,
        trace_id, created_at_ms, updated_at_ms
      ) VALUES (
        'in_existing', 'delivery_existing', 'provider_message_existing',
        '+15550000002', 'guid_existing', '+15550000002', 'line_existing',
        '+15550000001', 1, 'done', 'hello', 0, '{}', 'trace_existing', 1, 1
      );
      INSERT INTO jobs(
        id, chat_id, type, subject_id, payload_json, status, attempts,
        available_at_ms, lease_token, lease_expires_at_ms, trace_id, run_id,
        inbound_sequence, last_error, created_at_ms, updated_at_ms
      ) VALUES (
        'job_existing', '+15550000002', 'inbound', 'in_existing',
        '{"inboundId":"in_existing"}', 'succeeded', 1, 1, NULL, NULL,
        'trace_existing', 'run_existing', 1, NULL, 1, 1
      );
      INSERT INTO agent_runs(
        id, inbound_id, trace_id, phase, model_requests, maintenance_requests,
        tool_calls, provider_writes, deadline_at_ms, transcript_bytes,
        memory_maintenance_status, memory_before_digest, memory_after_digest,
        ambiguous_write_id, final_response, failure_code, created_at_ms, updated_at_ms
      ) VALUES (
        'run_existing', 'in_existing', 'trace_existing', 'completed', 1, 0,
        0, 0, 1000, 5, 'unchanged', NULL, NULL, NULL, 'hello', NULL, 1, 1
      );
      INSERT INTO agent_messages(
        run_id, sequence, role, content, reasoning_content, tool_calls_json,
        tool_call_id, provider_response_id, finish_reason, usage_json,
        byte_count, created_at_ms
      ) VALUES (
        'run_existing', 1, 'assistant', 'hello', NULL, NULL, NULL, NULL,
        'stop', NULL, 5, 1
      );
    `);

    try {
      runMigrations(db);

      expect(
        db
          .prepare<[], { inbound_id: string | null; scheduled_job_id: string | null }>(
            "SELECT inbound_id, scheduled_job_id FROM agent_runs WHERE id = 'run_existing'",
          )
          .get(),
      ).toEqual({ inbound_id: "in_existing", scheduled_job_id: null });
      expect(
        db.prepare<[], { content: string }>(
          "SELECT content FROM agent_messages WHERE run_id = 'run_existing'",
        ).get(),
      ).toEqual({ content: "hello" });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);

      db.exec(`
        INSERT INTO jobs(
          id, chat_id, type, subject_id, payload_json, status, attempts,
          available_at_ms, lease_token, lease_expires_at_ms, trace_id, run_id,
          inbound_sequence, last_error, created_at_ms, updated_at_ms
        ) VALUES (
          'job_daily', '+15550000002', 'daily_brief', '2026-09-01',
          '{"localDate":"2026-09-01","scheduledForMs":1}', 'pending', 0,
          1, NULL, NULL, 'trace_daily', NULL, NULL, NULL, 1, 1
        );
        INSERT INTO agent_runs(
          id, inbound_id, scheduled_job_id, trace_id, phase, model_requests,
          maintenance_requests, tool_calls, provider_writes, deadline_at_ms,
          transcript_bytes, memory_maintenance_status, memory_before_digest,
          memory_after_digest, ambiguous_write_id, final_response, failure_code,
          created_at_ms, updated_at_ms
        ) VALUES (
          'run_daily', NULL, 'job_daily', 'trace_daily', 'running', 0, 0,
          0, 0, 1000, 0, 'pending', NULL, NULL, NULL, NULL, NULL, 1, 1
        );
      `);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });


  it("terminalizes legacy messaging work while migrating its write-intent kind", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations(version, applied_at_ms)
      VALUES (1, 1), (2, 1), (3, 1);

      CREATE TABLE trace_streams (
        trace_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at_ms INTEGER,
        trace_id TEXT NOT NULL,
        last_error TEXT
      ) STRICT;
      CREATE TABLE inbound_messages (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      ) STRICT;
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE tool_executions (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE connections (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE egress_messages (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        state TEXT NOT NULL,
        last_error TEXT
      ) STRICT;
      CREATE TABLE write_intents (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES agent_runs(id),
        tool_execution_id TEXT UNIQUE REFERENCES tool_executions(id),
        egress_id TEXT UNIQUE REFERENCES egress_messages(id),
        connection_id TEXT REFERENCES connections(id),
        kind TEXT NOT NULL CHECK (kind IN (
          'gmail_create_draft', 'gmail_send_draft', 'notion_create_page',
          'notion_update_page', 'messages_send'
        )),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'attempting', 'succeeded', 'confirmed_failed',
          'ambiguous', 'reconciled_succeeded', 'unresolved'
        )),
        request_fingerprint TEXT NOT NULL,
        safe_summary_json TEXT NOT NULL CHECK (json_valid(safe_summary_json)),
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        connection_generation INTEGER,
        provider_reference_json TEXT CHECK (
          provider_reference_json IS NULL OR json_valid(provider_reference_json)
        ),
        attempted_at_ms INTEGER,
        completed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (run_id IS NOT NULL OR egress_id IS NOT NULL)
      ) STRICT;

      INSERT INTO egress_messages(id, trace_id, state, last_error)
      VALUES
        ('egress_prepared', 'trace_prepared', 'prepared', NULL),
        ('egress_attempting', 'trace_attempting', 'attempting', NULL),
        ('egress_accepted', 'trace_accepted', 'accepted', NULL);
      INSERT INTO trace_streams(trace_id, state, updated_at_ms)
      VALUES
        ('trace_prepared', 'open', 1),
        ('trace_attempting', 'open', 1),
        ('trace_accepted', 'open', 1),
        ('trace_voice', 'open', 1);
      INSERT INTO jobs(
        id, type, subject_id, status, lease_token, lease_expires_at_ms, trace_id, last_error
      )
      VALUES
        ('job_prepared', 'egress_send', 'egress_prepared', 'pending', NULL, NULL, 'trace_prepared', NULL),
        ('job_attempting', 'egress_send', 'egress_attempting', 'running', 'lease', 99, 'trace_attempting', NULL),
        ('job_accepted', 'egress_reconcile', 'egress_accepted', 'pending', NULL, NULL, 'trace_accepted', NULL),
        ('job_voice', 'voice_poll', 'inbound_voice', 'pending', NULL, NULL, 'trace_voice', NULL);
      INSERT INTO inbound_messages(id, state)
      VALUES ('inbound_voice', 'waiting_transcription');
      INSERT INTO write_intents(
        id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
        request_fingerprint, safe_summary_json, request_json, connection_generation,
        provider_reference_json, attempted_at_ms, completed_at_ms, created_at_ms,
        updated_at_ms
      )
      VALUES
        ('write_prepared', NULL, NULL, 'egress_prepared', NULL, 'messages_send', 'prepared',
         'fp1', '{}', '{}', NULL, NULL, NULL, NULL, 1, 1),
        ('write_attempting', NULL, NULL, 'egress_attempting', NULL, 'messages_send', 'attempting',
         'fp2', '{}', '{}', NULL, NULL, 1, NULL, 1, 1),
        ('write_accepted', NULL, NULL, 'egress_accepted', NULL, 'messages_send', 'succeeded',
         'fp3', '{}', '{}', NULL, '{}', 1, 1, 1, 1);
    `);

    try {
      runMigrations(db, 4);

      expect(
        db
          .prepare<[], { id: string; kind: string; state: string; completed_at_ms: number | null }>(`
            SELECT id, kind, state, completed_at_ms
            FROM write_intents ORDER BY id
          `)
          .all(),
      ).toEqual([
        {
          id: "write_accepted",
          kind: "sendblue_send_message",
          state: "succeeded",
          completed_at_ms: 1,
        },
        {
          id: "write_attempting",
          kind: "sendblue_send_message",
          state: "ambiguous",
          completed_at_ms: 1,
        },
        {
          id: "write_prepared",
          kind: "sendblue_send_message",
          state: "confirmed_failed",
          completed_at_ms: 1,
        },
      ]);
      expect(
        db
          .prepare<[], { id: string; state: string }>(`
            SELECT id, state FROM egress_messages ORDER BY id
          `)
          .all(),
      ).toEqual([
        { id: "egress_accepted", state: "delivery_unknown" },
        { id: "egress_attempting", state: "acceptance_unknown" },
        { id: "egress_prepared", state: "provider_failed" },
      ]);
      expect(
        db
          .prepare<[], { status: string }>(
            "SELECT DISTINCT status FROM jobs WHERE id IN ('job_prepared', 'job_attempting', 'job_accepted', 'job_voice')",
          )
          .all(),
      ).toEqual([{ status: "blocked" }]);
      expect(
        db.prepare<[], { state: string }>(
          "SELECT state FROM inbound_messages WHERE id = 'inbound_voice'",
        ).get(),
      ).toEqual({ state: "blocked" });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("trace projection", () => {
  it("redacts secrets and repairs a malformed JSONL tail from the spool", () => {
    testDatabase = createTestDatabase();
    const traceId = newTraceId();
    const redactor = createTraceRedactor(["top-secret-value"]);
    const store = new TraceStore(testDatabase.handle.db, redactor);
    const projector = new TraceProjector(
      testDatabase.handle.db,
      store,
      testDatabase.config.traceDir,
    );

    store.append({
      traceId,
      component: "webhook",
      event: "verified",
      outcome: "accepted",
      data: {
        apiKey: "top-secret-value",
        providerState: "{\"extra_content\":{\"google\":{\"thought_signature\":\"opaque\"}}}",
        link: "https://assistant.example.com/connect/google?token=bearer-value",
      },
    });
    store.markTerminal(traceId);
    const tracePath = projector.project(traceId);
    let content = readFileSync(tracePath, "utf8");
    expect(content).not.toContain("top-secret-value");
    expect(content).not.toContain("bearer-value");
    expect(content).not.toContain("thought_signature");
    expect(projector.read(traceId)).toHaveLength(1);

    appendFileSync(tracePath, "{malformed");
    store.append({
      traceId,
      component: "egress",
      event: "delivered",
      outcome: "success",
      data: { providerMessageId: "msg_test" },
    });
    store.markTerminal(traceId);
    const repaired = projector.read(traceId);
    content = readFileSync(tracePath, "utf8");

    expect(repaired.map((event) => event.event)).toEqual(["verified", "delivered"]);
    expect(content).not.toContain("malformed");
    expect(renderTrace(repaired)).toContain("egress.delivered [success]");
  });
});
