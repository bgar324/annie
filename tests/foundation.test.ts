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
    DEEPSEEK_API_KEY: "deepseek_test_key",
    GOOGLE_CLIENT_ID: "google_test_client",
    GOOGLE_CLIENT_SECRET: "google_test_secret",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

describe("runtime configuration", () => {
  it("derives fixed callbacks, scopes, and storage paths from validated input", () => {
    testDatabase = createTestDatabase();
    const environment = validEnvironment(testDatabase.directory);
    environment.GOOGLE_WORKSPACE_SCOPES =
      "openid email https://www.googleapis.com/auth/gmail.modify";
    const config = loadRuntimeConfig(environment);

    expect(config.google.callbackUrl).toBe("http://localhost:3000/oauth/google/callback");
    expect(config.notion.callbackUrl).toBe("http://localhost:3000/oauth/notion/callback");
    expect(config.google.scopes).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/tasks.readonly",
    ]);
    expect(config.credentialEncryptionKey).toHaveLength(32);
    expect(config.sendblue).toEqual({
      apiKeyId: "sendblue_test_key_id",
      apiSecretKey: "sendblue_test_secret_key",
      fromNumber: "+15550000001",
      baseUrl: "https://api.sendblue.co",
    });
    expect(config.deepseek).toEqual({
      apiKey: "deepseek_test_key",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      reasoningEffort: "high",
      requestTimeoutMs: 90_000,
    });
    expect(config.dailyBrief).toEqual({
      enabled: false,
      timeZone: "America/Los_Angeles",
    });
    expect(config.userPhoneNumber).toBe("+15550000002");
    expect(config.databasePath).toBe(join(testDatabase.directory, "assistant.sqlite"));
  });

  it("fails closed for unusable numbers and production storage", () => {
    testDatabase = createTestDatabase();

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

    const deepseekEnvironment = validEnvironment(testDatabase.directory);
    deepseekEnvironment.NODE_ENV = "production";
    deepseekEnvironment.PUBLIC_BASE_URL = "https://assistant.example.com";
    deepseekEnvironment.RAILWAY_VOLUME_MOUNT_PATH = testDatabase.directory;
    deepseekEnvironment.DATA_DIR = testDatabase.directory;
    deepseekEnvironment.DEEPSEEK_BASE_URL = "http://deepseek.example.test";

    expect(() => loadRuntimeConfig(deepseekEnvironment)).toThrow(
      /DEEPSEEK_BASE_URL must use HTTPS in production/u,
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
  it("forces a safe read-only Google reconnect while preserving unrelated state", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, 5);
    db.exec(`
      INSERT INTO connections(
        id, provider, provider_account_id, safe_label, normalized_safe_label,
        status, credential_generation, health_generation, checked_at_ms,
        last_success_at_ms, retry_at_ms, last_error_code, last_error_summary,
        safe_metadata_json, provider_state_json, created_at_ms, updated_at_ms
      ) VALUES
        (
          'connection_google', 'google', 'google_sub', 'Google', 'google',
          'healthy', 1, 2, 1, 1, NULL, NULL, NULL, '{}',
          '{"scopes":["https://www.googleapis.com/auth/gmail.modify"]}', 1, 1
        ),
        (
          'connection_notion', 'notion', 'notion_workspace', 'Notion', 'notion',
          'healthy', 1, 1, 1, 1, NULL, NULL, NULL, '{}', '{}', 1, 1
        );
      INSERT INTO connection_capabilities(connection_id, capability) VALUES
        ('connection_google', 'gmail.search'),
        ('connection_google', 'gmail.read_thread'),
        ('connection_google', 'gmail.create_draft'),
        ('connection_google', 'gmail.send_draft'),
        ('connection_notion', 'notion.search');
      INSERT INTO refresh_leases(
        connection_id, credential_generation, lease_token, lease_expires_at_ms,
        dispatch_state, updated_at_ms
      ) VALUES ('connection_google', 1, 'lease_google', 999999, 'claimed', 1);

      INSERT INTO oauth_link_tokens(
        id, jti_hash, provider, purpose, expected_connection_id, trace_id,
        issued_at_ms, expires_at_ms, consumed_at_ms
      ) VALUES
        ('link_google_pending', 'hash_google_pending', 'google', 'connect', NULL, 'trace_oauth_1', 1, 999, NULL),
        ('link_google_active', 'hash_google_active', 'google', 'connect', NULL, 'trace_oauth_2', 1, 999, NULL),
        ('link_notion_pending', 'hash_notion_pending', 'notion', 'connect', NULL, 'trace_oauth_3', 1, 999, NULL);
      INSERT INTO oauth_attempts(
        id, link_token_id, provider, expected_connection_id, state_hash, status,
        key_version, nonce, ciphertext, auth_tag, authorization_url,
        provider_identity, failure_code, expires_at_ms, state_consumed_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES
        (
          'attempt_google_pending', 'link_google_pending', 'google', NULL,
          'state_google_pending', 'pending', 1, X'01', X'02', X'03',
          'https://accounts.google.example/auth', NULL, NULL, 999, NULL, 1, 1
        ),
        (
          'attempt_google_active', 'link_google_active', 'google', NULL,
          'state_google_active', 'active', 1, X'01', X'02', X'03',
          'https://accounts.google.example/auth', 'google_sub', NULL, 999, 1, 1, 1
        ),
        (
          'attempt_notion_pending', 'link_notion_pending', 'notion', NULL,
          'state_notion_pending', 'pending', 1, X'01', X'02', X'03',
          'https://notion.example/auth', NULL, NULL, 999, NULL, 1, 1
        );

      INSERT INTO webhook_deliveries(
        id, provider_delivery_id, provider_message_id, event_kind, line_id,
        line_handle, outbox_id, normalized_json, trace_id, received_at_ms
      ) VALUES
        ('delivery_write', 'provider_delivery_write', 'provider_message_write', 'message.received', 'line', '+15550000001', NULL, '{}', 'trace_write', 1),
        ('delivery_read', 'provider_delivery_read', 'provider_message_read', 'message.received', 'line', '+15550000001', NULL, '{}', 'trace_read', 1);
      INSERT INTO inbound_messages(
        id, delivery_id, provider_message_id, chat_id, guid, sender, line_id,
        line_handle, sequence, state, text, is_audio, attachment_json, trace_id,
        created_at_ms, updated_at_ms
      ) VALUES
        ('inbound_write', 'delivery_write', 'provider_message_write', 'chat', 'guid_write', '+15550000002', 'line', '+15550000001', 1, 'processing', 'send it', 0, NULL, 'trace_write', 1, 1),
        ('inbound_read', 'delivery_read', 'provider_message_read', 'chat', 'guid_read', '+15550000002', 'line', '+15550000001', 2, 'processing', 'read it', 0, NULL, 'trace_read', 1, 1);
      INSERT INTO agent_runs(
        id, inbound_id, scheduled_job_id, trace_id, phase, model_requests,
        maintenance_requests, tool_calls, provider_writes, deadline_at_ms,
        transcript_bytes, memory_maintenance_status, memory_before_digest,
        memory_after_digest, ambiguous_write_id, final_response, failure_code,
        created_at_ms, updated_at_ms
      ) VALUES
        ('run_write', 'inbound_write', NULL, 'trace_write', 'running', 1, 0, 1, 0, 999, 1, 'pending', NULL, NULL, NULL, NULL, NULL, 1, 1),
        ('run_read', 'inbound_read', NULL, 'trace_read', 'running', 1, 0, 1, 0, 999, 1, 'pending', NULL, NULL, NULL, NULL, NULL, 1, 1);
      INSERT INTO agent_messages(
        run_id, sequence, role, content, reasoning_content, tool_calls_json,
        tool_call_id, provider_response_id, finish_reason, usage_json,
        byte_count, created_at_ms
      ) VALUES
        (
          'run_write', 1, 'assistant', '', NULL,
          '[{"id":"call_write","name":"gmail.send_draft","argumentsJson":"{}"}]',
          NULL, NULL, 'tool_calls', NULL, 0, 1
        ),
        (
          'run_read', 1, 'assistant', '', NULL,
          '[{"id":"call_read","name":"gmail.search","argumentsJson":"{}"}]',
          NULL, NULL, 'tool_calls', NULL, 0, 1
        );
      INSERT INTO tool_executions(
        id, run_id, tool_call_id, tool_name, arguments_json, connection_id,
        operation_class, status, result_json, write_intent_id, created_at_ms,
        updated_at_ms
      ) VALUES
        (
          'tool_write', 'run_write', 'call_write', 'gmail.send_draft', '{}',
          'connection_google', 'write', 'running', NULL, 'write_google', 1, 1
        ),
        (
          'tool_read', 'run_read', 'call_read', 'gmail.search', '{}',
          'connection_google', 'read', 'running', NULL, NULL, 1, 1
        );
      INSERT INTO write_intents(
        id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
        request_fingerprint, safe_summary_json, request_json,
        connection_generation, provider_reference_json, attempted_at_ms,
        completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        'write_google', 'run_write', 'tool_write', NULL, 'connection_google',
        'gmail_send_draft', 'prepared', 'fingerprint', '{}', '{}', 1, NULL,
        NULL, NULL, 1, 1
      );
    `);

    try {
      runMigrations(db);

      expect(
        db.prepare<[], {
          status: string;
          health_generation: number;
          last_error_code: string | null;
        }>(`
          SELECT status, health_generation, last_error_code
          FROM connections WHERE id = 'connection_google'
        `).get(),
      ).toEqual({
        status: "reconnect_required",
        health_generation: 3,
        last_error_code: "google_scope_cutover",
      });
      expect(
        db.prepare<[], { connection_id: string; capability: string }>(`
          SELECT connection_id, capability FROM connection_capabilities
          ORDER BY connection_id, capability
        `).all(),
      ).toEqual([{ connection_id: "connection_notion", capability: "notion.search" }]);
      expect(db.prepare("SELECT * FROM refresh_leases").all()).toEqual([]);
      expect(
        db.prepare<[], { id: string; status: string; failure_code: string | null }>(`
          SELECT id, status, failure_code FROM oauth_attempts ORDER BY id
        `).all(),
      ).toEqual([
        { id: "attempt_google_active", status: "active", failure_code: null },
        {
          id: "attempt_google_pending",
          status: "failed",
          failure_code: "google_scope_cutover",
        },
        { id: "attempt_notion_pending", status: "pending", failure_code: null },
      ]);
      expect(
        db.prepare<[], { id: string; phase: string; failure_code: string | null }>(`
          SELECT id, phase, failure_code FROM agent_runs ORDER BY id
        `).all(),
      ).toEqual([
        { id: "run_read", phase: "running", failure_code: null },
        {
          id: "run_write",
          phase: "blocked",
          failure_code: "google_write_tools_removed",
        },
      ]);
      expect(
        db.prepare<[], { id: string; state: string }>(`
          SELECT id, state FROM inbound_messages ORDER BY id
        `).all(),
      ).toEqual([
        { id: "inbound_read", state: "processing" },
        { id: "inbound_write", state: "blocked" },
      ]);
      expect(
        db.prepare<[], { status: string; result_json: string | null }>(
          "SELECT status, result_json FROM tool_executions WHERE id = 'tool_write'",
        ).get(),
      ).toEqual({
        status: "not_executed",
        result_json:
          '{"error":{"code":"google_write_tools_removed","message":"Google write tools were removed"},"ok":false}',
      });
      expect(
        db.prepare<[], { state: string; completed: number }>(`
          SELECT state, completed_at_ms IS NOT NULL AS completed
          FROM write_intents WHERE id = 'write_google'
        `).get(),
      ).toEqual({ state: "confirmed_failed", completed: 1 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("restores only Notion connections tripped by the removed schema guard", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, 6);
    db.exec(`
      INSERT INTO connections(
        id, provider, provider_account_id, safe_label, normalized_safe_label,
        status, credential_generation, health_generation, checked_at_ms,
        last_success_at_ms, retry_at_ms, last_error_code, last_error_summary,
        safe_metadata_json, provider_state_json, created_at_ms, updated_at_ms
      ) VALUES
        (
          'notion_schema', 'notion', 'workspace_schema', 'Schema', 'schema',
          'reconnect_required', 1, 2, 1, 1, NULL, 'schema_drift', 'old guard',
          '{}', '{"notionToolSchemaHashes":{"notion-search":"old"},"tokenEndpoint":"https://mcp.notion.test/token"}', 1, 1
        ),
        (
          'notion_tool', 'notion', 'workspace_tool', 'Tool', 'tool',
          'reconnect_required', 1, 4, 1, 1, NULL, 'tool_unavailable', 'old guard',
          '{}', '{"notionToolSchemaHashes":{"notion-fetch":"old"},"tokenEndpoint":"https://mcp.notion.test/token"}', 1, 1
        ),
        (
          'notion_auth', 'notion', 'workspace_auth', 'Auth', 'auth',
          'reconnect_required', 1, 6, 1, 1, NULL, 'invalid_grant', 'revoked',
          '{}', '{"notionToolSchemaHashes":{"notion-fetch":"old"},"tokenEndpoint":"https://mcp.notion.test/token"}', 1, 1
        ),
        (
          'google_schema', 'google', 'google_sub', 'Google', 'google',
          'reconnect_required', 1, 8, 1, 1, NULL, 'schema_drift', 'unrelated',
          '{}', '{"notionToolSchemaHashes":{"notion-search":"old"}}', 1, 1
        );
    `);

    try {
      runMigrations(db);

      expect(
        db.prepare<[], {
          id: string;
          status: string;
          health_generation: number;
          last_error_code: string | null;
          last_error_summary: string | null;
          provider_state_json: string;
        }>(`
          SELECT id, status, health_generation, last_error_code,
                 last_error_summary, provider_state_json
          FROM connections ORDER BY id
        `).all(),
      ).toEqual([
        {
          id: "google_schema",
          status: "reconnect_required",
          health_generation: 8,
          last_error_code: "schema_drift",
          last_error_summary: "unrelated",
          provider_state_json: '{"notionToolSchemaHashes":{"notion-search":"old"}}',
        },
        {
          id: "notion_auth",
          status: "reconnect_required",
          health_generation: 6,
          last_error_code: "invalid_grant",
          last_error_summary: "revoked",
          provider_state_json: '{"tokenEndpoint":"https://mcp.notion.test/token"}',
        },
        {
          id: "notion_schema",
          status: "healthy",
          health_generation: 3,
          last_error_code: null,
          last_error_summary: null,
          provider_state_json: '{"tokenEndpoint":"https://mcp.notion.test/token"}',
        },
        {
          id: "notion_tool",
          status: "healthy",
          health_generation: 5,
          last_error_code: null,
          last_error_summary: null,
          provider_state_json: '{"tokenEndpoint":"https://mcp.notion.test/token"}',
        },
      ]);
    } finally {
      db.close();
    }
  });
  it("preserves queued run children while adding durable memory jobs", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, 7);
    db.exec(`
      INSERT INTO jobs(
        id, chat_id, type, subject_id, payload_json, status, attempts,
        available_at_ms, lease_token, lease_expires_at_ms, trace_id, run_id,
        inbound_sequence, last_error, created_at_ms, updated_at_ms
      ) VALUES (
        'job_daily_v7', '+15550000002', 'daily_brief', '2026-06-03',
        '{"localDate":"2026-06-03","scheduledForMs":1}', 'succeeded', 1,
        1, NULL, NULL, 'trace_daily_v7', 'run_daily_v7', NULL, NULL, 1, 1
      );
      INSERT INTO agent_runs(
        id, inbound_id, scheduled_job_id, trace_id, phase, model_requests,
        maintenance_requests, tool_calls, provider_writes, deadline_at_ms,
        transcript_bytes, memory_maintenance_status, memory_before_digest,
        memory_after_digest, ambiguous_write_id, final_response, failure_code,
        created_at_ms, updated_at_ms
      ) VALUES (
        'run_daily_v7', NULL, 'job_daily_v7', 'trace_daily_v7', 'completed',
        1, 0, 0, 0, 1000, 12, 'pending', NULL, NULL, NULL, 'brief', NULL, 1, 1
      );
      INSERT INTO agent_messages(
        run_id, sequence, role, content, reasoning_content, tool_calls_json,
        tool_call_id, provider_response_id, finish_reason, usage_json,
        byte_count, created_at_ms
      ) VALUES (
        'run_daily_v7', 1, 'user', 'daily request', NULL, NULL, NULL, NULL,
        NULL, NULL, 12, 1
      );
    `);

    try {
      runMigrations(db);

      expect(
        db.prepare<[], {
          type: string;
          scheduled_job_id: string;
          content: string;
        }>(`
          SELECT jobs.type, agent_runs.scheduled_job_id, agent_messages.content
          FROM agent_runs
          JOIN jobs ON jobs.id = agent_runs.scheduled_job_id
          JOIN agent_messages ON agent_messages.run_id = agent_runs.id
          WHERE agent_runs.id = 'run_daily_v7'
        `).get(),
      ).toEqual({
        type: "daily_brief",
        scheduled_job_id: "job_daily_v7",
        content: "daily request",
      });
      db.exec(`
        INSERT INTO jobs(
          id, chat_id, type, subject_id, payload_json, status, attempts,
          available_at_ms, lease_token, lease_expires_at_ms, trace_id, run_id,
          inbound_sequence, last_error, created_at_ms, updated_at_ms
        ) VALUES (
          'job_memory_v8', '+15550000002', 'memory_maintenance', 'run_daily_v7',
          '{"runId":"run_daily_v7"}', 'pending', 0, 1, NULL, NULL,
          'trace_daily_v7', 'run_daily_v7', NULL, NULL, 1, 1
        );
      `);
      expect(
        () =>
          db.prepare(`
            INSERT INTO jobs(
              id, chat_id, type, subject_id, payload_json, status, attempts,
              available_at_ms, trace_id, created_at_ms, updated_at_ms
            ) VALUES (
              'job_invalid_v8', '+15550000002', 'arbitrary_work', 'invalid',
              '{}', 'pending', 0, 1, 'trace_invalid_v8', 1, 1
            )
          `).run(),
      ).toThrow(/CHECK constraint failed/u);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });


});

describe("trace projection", () => {
  it("redacts the DeepSeek key and reasoning state while repairing malformed JSONL", () => {
    testDatabase = createTestDatabase();
    const config = loadRuntimeConfig(validEnvironment(testDatabase.directory));
    const traceId = newTraceId();
    const redactor = createTraceRedactor(config.secretValues);
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
        apiKey: "deepseek_test_key",
        providerState: "{\"reasoning_content\":\"opaque\"}",
        link: "https://assistant.example.com/connect/google?token=bearer-value",
      },
    });
    store.markTerminal(traceId);
    const tracePath = projector.project(traceId);
    let content = readFileSync(tracePath, "utf8");
    expect(content).not.toContain("deepseek_test_key");
    expect(content).not.toContain("bearer-value");
    expect(content).not.toContain("reasoning_content");
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
