import type Database from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
  rebuildsForeignKeys?: boolean;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE webhook_deliveries (
        id TEXT PRIMARY KEY,
        provider_delivery_id TEXT NOT NULL UNIQUE,
        provider_message_id TEXT,
        event_kind TEXT NOT NULL,
        line_id TEXT,
        line_handle TEXT,
        outbox_id TEXT,
        normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
        trace_id TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX webhook_deliveries_provider_message
        ON webhook_deliveries(provider_message_id)
        WHERE provider_message_id IS NOT NULL;

      CREATE TABLE inbound_messages (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE REFERENCES webhook_deliveries(id),
        provider_message_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        guid TEXT NOT NULL,
        sender TEXT NOT NULL,
        line_id TEXT NOT NULL,
        line_handle TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN (
          'waiting_transcription', 'ready', 'processing', 'done', 'rejected', 'blocked'
        )),
        text TEXT,
        is_audio INTEGER NOT NULL CHECK (is_audio IN (0, 1)),
        attachment_json TEXT CHECK (attachment_json IS NULL OR json_valid(attachment_json)),
        trace_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'inbound', 'voice_poll', 'egress_send', 'egress_reconcile'
        )),
        subject_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'running', 'succeeded', 'failed', 'blocked'
        )),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at_ms INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at_ms INTEGER,
        trace_id TEXT NOT NULL,
        run_id TEXT,
        inbound_sequence INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(type, subject_id),
        CHECK (
          (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
          OR
          (status <> 'running' AND lease_token IS NULL AND lease_expires_at_ms IS NULL)
        )
      ) STRICT;
      CREATE INDEX jobs_claim
        ON jobs(status, available_at_ms, inbound_sequence, created_at_ms);
      CREATE UNIQUE INDEX jobs_one_running_chat
        ON jobs(chat_id) WHERE status = 'running';

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        inbound_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages(id),
        trace_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK (phase IN (
          'pending', 'running', 'finalizing', 'completed', 'failed', 'blocked'
        )),
        model_requests INTEGER NOT NULL DEFAULT 0 CHECK (model_requests >= 0),
        maintenance_requests INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_requests >= 0),
        tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
        provider_writes INTEGER NOT NULL DEFAULT 0 CHECK (provider_writes >= 0),
        deadline_at_ms INTEGER NOT NULL,
        transcript_bytes INTEGER NOT NULL DEFAULT 0 CHECK (transcript_bytes >= 0),
        memory_maintenance_status TEXT NOT NULL CHECK (memory_maintenance_status IN (
          'pending', 'attempting', 'unchanged', 'updated', 'invalid', 'failed'
        )),
        memory_before_digest TEXT,
        memory_after_digest TEXT,
        ambiguous_write_id TEXT,
        final_response TEXT,
        failure_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE agent_messages (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        reasoning_content TEXT,
        tool_calls_json TEXT CHECK (tool_calls_json IS NULL OR json_valid(tool_calls_json)),
        tool_call_id TEXT,
        provider_response_id TEXT,
        finish_reason TEXT,
        usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
        byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(run_id, sequence)
      ) STRICT;

      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('google', 'notion')),
        provider_account_id TEXT NOT NULL,
        safe_label TEXT NOT NULL,
        normalized_safe_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'healthy', 'degraded', 'reconnect_required', 'disconnected'
        )),
        credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
        health_generation INTEGER NOT NULL CHECK (health_generation >= 1),
        checked_at_ms INTEGER,
        last_success_at_ms INTEGER,
        retry_at_ms INTEGER,
        last_error_code TEXT,
        last_error_summary TEXT,
        safe_metadata_json TEXT NOT NULL CHECK (json_valid(safe_metadata_json)),
        provider_state_json TEXT NOT NULL CHECK (json_valid(provider_state_json)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(provider, provider_account_id),
        UNIQUE(provider, normalized_safe_label)
      ) STRICT;

      CREATE TABLE connection_capabilities (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        PRIMARY KEY(connection_id, capability)
      ) STRICT;

      CREATE TABLE connection_secrets (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        key_version INTEGER NOT NULL CHECK (key_version >= 1),
        credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        expires_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE refresh_leases (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        credential_generation INTEGER NOT NULL,
        lease_token TEXT NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL,
        dispatch_state TEXT NOT NULL CHECK (dispatch_state IN (
          'claimed', 'dispatched', 'completed', 'ambiguous'
        )),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE oauth_link_tokens (
        id TEXT PRIMARY KEY,
        jti_hash TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL CHECK (provider IN ('google', 'notion')),
        purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'reconnect')),
        expected_connection_id TEXT REFERENCES connections(id),
        trace_id TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER
      ) STRICT;

      CREATE TABLE oauth_attempts (
        id TEXT PRIMARY KEY,
        link_token_id TEXT NOT NULL UNIQUE REFERENCES oauth_link_tokens(id),
        provider TEXT NOT NULL CHECK (provider IN ('google', 'notion')),
        expected_connection_id TEXT REFERENCES connections(id),
        state_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'exchange_started', 'tokens_saved', 'active', 'failed', 'expired'
        )),
        key_version INTEGER NOT NULL CHECK (key_version >= 1),
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        authorization_url TEXT NOT NULL,
        provider_identity TEXT,
        failure_code TEXT,
        expires_at_ms INTEGER NOT NULL,
        state_consumed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE egress_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES agent_runs(id),
        trace_id TEXT NOT NULL,
        recipient_handle TEXT NOT NULL,
        line_handle TEXT NOT NULL,
        reply_to_guid TEXT,
        body TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN (
          'reply', 'recovery', 'oauth_result', 'voice_failure', 'failure'
        )),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'attempting', 'accepted', 'sent', 'delivered',
          'provider_failed', 'acceptance_unknown', 'delivery_unknown'
        )),
        attempt_count INTEGER NOT NULL CHECK (attempt_count IN (0, 1)),
        outbox_id TEXT UNIQUE,
        request_id TEXT,
        provider_message_id TEXT UNIQUE,
        poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
        poll_deadline_at_ms INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE recovery_notices (
        connection_id TEXT NOT NULL REFERENCES connections(id),
        health_generation INTEGER NOT NULL,
        oauth_link_id TEXT NOT NULL REFERENCES oauth_link_tokens(id),
        egress_id TEXT NOT NULL UNIQUE REFERENCES egress_messages(id),
        status TEXT NOT NULL CHECK (status IN ('planned', 'attempted')),
        created_at_ms INTEGER NOT NULL,
        attempted_at_ms INTEGER,
        PRIMARY KEY(connection_id, health_generation)
      ) STRICT;

      CREATE TABLE tool_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
        connection_id TEXT REFERENCES connections(id),
        operation_class TEXT NOT NULL CHECK (operation_class IN ('read', 'write')),
        status TEXT NOT NULL CHECK (status IN (
          'validated', 'running', 'succeeded', 'failed', 'ambiguous', 'not_executed'
        )),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        write_intent_id TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(run_id, tool_call_id)
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

      CREATE TABLE gmail_drafts (
        connection_id TEXT NOT NULL REFERENCES connections(id),
        provider_draft_id TEXT NOT NULL,
        provider_message_id TEXT,
        provider_thread_id TEXT,
        rfc_message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'draft', 'send_attempting', 'sent', 'ambiguous'
        )),
        safe_summary_json TEXT NOT NULL CHECK (json_valid(safe_summary_json)),
        sent_message_id TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(connection_id, provider_draft_id),
        UNIQUE(connection_id, rfc_message_id)
      ) STRICT;

      CREATE TABLE trace_streams (
        trace_id TEXT PRIMARY KEY,
        run_id TEXT,
        next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
        state TEXT NOT NULL CHECK (state IN ('open', 'terminal', 'exported')),
        event_count INTEGER NOT NULL CHECK (event_count >= 0),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE trace_event_spool (
        trace_id TEXT NOT NULL REFERENCES trace_streams(trace_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        component TEXT NOT NULL,
        event TEXT NOT NULL,
        outcome TEXT,
        provider_request_id TEXT,
        job_id TEXT,
        run_id TEXT,
        tool_execution_id TEXT,
        write_intent_id TEXT,
        redacted_json TEXT NOT NULL CHECK (json_valid(redacted_json)),
        PRIMARY KEY(trace_id, sequence)
      ) STRICT;

      CREATE TABLE trace_exports (
        trace_id TEXT PRIMARY KEY REFERENCES trace_streams(trace_id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL UNIQUE,
        exported_sequence INTEGER NOT NULL CHECK (exported_sequence >= 0),
        file_digest TEXT,
        finalized_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE UNIQUE INDEX egress_one_failure_notification
        ON egress_messages(trace_id, purpose)
        WHERE purpose IN ('voice_failure', 'failure');
      CREATE UNIQUE INDEX egress_one_trace_reply
        ON egress_messages(trace_id, purpose)
        WHERE purpose = 'reply';
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE memory_updates (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        before_digest TEXT NOT NULL,
        after_digest TEXT NOT NULL,
        diff TEXT NOT NULL,
        usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
        created_at_ms INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE sendblue_ingress_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        recovered_once INTEGER NOT NULL CHECK (recovered_once IN (0, 1))
      ) STRICT;

      UPDATE trace_streams
      SET state = 'terminal'
      WHERE state = 'open'
        AND trace_id IN (
          SELECT trace_id FROM jobs
          WHERE type = 'voice_poll' AND status IN ('pending', 'running')
        );

      UPDATE jobs
      SET status = 'blocked',
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          last_error = 'Sendblue does not provide inbound voice transcription'
      WHERE type = 'voice_poll' AND status IN ('pending', 'running');

      UPDATE inbound_messages
      SET state = 'blocked'
      WHERE state = 'waiting_transcription';

      UPDATE trace_streams
      SET state = 'terminal'
      WHERE state = 'open'
        AND trace_id IN (
          SELECT trace_id FROM egress_messages
          WHERE state IN ('prepared', 'attempting', 'accepted', 'sent')
        );

      UPDATE egress_messages
      SET state = CASE state
            WHEN 'prepared' THEN 'provider_failed'
            WHEN 'attempting' THEN 'acceptance_unknown'
            ELSE 'delivery_unknown'
          END,
          last_error = 'Messages.dev transport retired during Sendblue cutover'
      WHERE state IN ('prepared', 'attempting', 'accepted', 'sent');

      UPDATE jobs
      SET status = 'blocked',
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          last_error = 'Messages.dev transport retired during Sendblue cutover'
      WHERE type IN ('egress_send', 'egress_reconcile')
        AND status IN ('pending', 'running')
        AND subject_id IN (
          SELECT id FROM egress_messages
          WHERE state IN ('provider_failed', 'acceptance_unknown', 'delivery_unknown')
        );

      UPDATE write_intents
      SET state = CASE state
            WHEN 'prepared' THEN 'confirmed_failed'
            WHEN 'attempting' THEN 'ambiguous'
            ELSE state
          END,
          completed_at_ms = COALESCE(completed_at_ms, updated_at_ms)
      WHERE kind = 'messages_send' AND state IN ('prepared', 'attempting');

      ALTER TABLE write_intents RENAME TO write_intents_messages_legacy;

      CREATE TABLE write_intents (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES agent_runs(id),
        tool_execution_id TEXT UNIQUE REFERENCES tool_executions(id),
        egress_id TEXT UNIQUE REFERENCES egress_messages(id),
        connection_id TEXT REFERENCES connections(id),
        kind TEXT NOT NULL CHECK (kind IN (
          'gmail_create_draft', 'gmail_send_draft', 'notion_create_page',
          'notion_update_page', 'sendblue_send_message'
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

      INSERT INTO write_intents(
        id, run_id, tool_execution_id, egress_id, connection_id, kind, state,
        request_fingerprint, safe_summary_json, request_json, connection_generation,
        provider_reference_json, attempted_at_ms, completed_at_ms, created_at_ms,
        updated_at_ms
      )
      SELECT
        id, run_id, tool_execution_id, egress_id, connection_id,
        CASE kind
          WHEN 'messages_send' THEN 'sendblue_send_message'
          ELSE kind
        END,
        state, request_fingerprint, safe_summary_json, request_json,
        connection_generation, provider_reference_json, attempted_at_ms,
        completed_at_ms, created_at_ms, updated_at_ms
      FROM write_intents_messages_legacy;

      DROP TABLE write_intents_messages_legacy;
    `,
  },
  {
    version: 5,
    rebuildsForeignKeys: true,
    sql: `
      CREATE TABLE jobs_v5 (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'inbound', 'voice_poll', 'egress_send', 'egress_reconcile', 'daily_brief'
        )),
        subject_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'running', 'succeeded', 'failed', 'blocked'
        )),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at_ms INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at_ms INTEGER,
        trace_id TEXT NOT NULL,
        run_id TEXT,
        inbound_sequence INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(type, subject_id),
        CHECK (
          (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
          OR
          (status <> 'running' AND lease_token IS NULL AND lease_expires_at_ms IS NULL)
        )
      ) STRICT;

      INSERT INTO jobs_v5(
        id, chat_id, type, subject_id, payload_json, status, attempts,
        available_at_ms, lease_token, lease_expires_at_ms, trace_id, run_id,
        inbound_sequence, last_error, created_at_ms, updated_at_ms
      )
      SELECT
        id, chat_id, type, subject_id, payload_json, status, attempts,
        available_at_ms, lease_token, lease_expires_at_ms, trace_id, run_id,
        inbound_sequence, last_error, created_at_ms, updated_at_ms
      FROM jobs;

      CREATE TABLE agent_runs_v5 (
        id TEXT PRIMARY KEY,
        inbound_id TEXT UNIQUE REFERENCES inbound_messages(id),
        scheduled_job_id TEXT UNIQUE REFERENCES jobs(id),
        trace_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK (phase IN (
          'pending', 'running', 'finalizing', 'completed', 'failed', 'blocked'
        )),
        model_requests INTEGER NOT NULL DEFAULT 0 CHECK (model_requests >= 0),
        maintenance_requests INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_requests >= 0),
        tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
        provider_writes INTEGER NOT NULL DEFAULT 0 CHECK (provider_writes >= 0),
        deadline_at_ms INTEGER NOT NULL,
        transcript_bytes INTEGER NOT NULL DEFAULT 0 CHECK (transcript_bytes >= 0),
        memory_maintenance_status TEXT NOT NULL CHECK (memory_maintenance_status IN (
          'pending', 'attempting', 'unchanged', 'updated', 'invalid', 'failed'
        )),
        memory_before_digest TEXT,
        memory_after_digest TEXT,
        ambiguous_write_id TEXT,
        final_response TEXT,
        failure_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (
          (inbound_id IS NOT NULL AND scheduled_job_id IS NULL)
          OR
          (inbound_id IS NULL AND scheduled_job_id IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO agent_runs_v5(
        id, inbound_id, scheduled_job_id, trace_id, phase, model_requests,
        maintenance_requests, tool_calls, provider_writes, deadline_at_ms,
        transcript_bytes, memory_maintenance_status, memory_before_digest,
        memory_after_digest, ambiguous_write_id, final_response, failure_code,
        created_at_ms, updated_at_ms
      )
      SELECT
        id, inbound_id, NULL, trace_id, phase, model_requests,
        maintenance_requests, tool_calls, provider_writes, deadline_at_ms,
        transcript_bytes, memory_maintenance_status, memory_before_digest,
        memory_after_digest, ambiguous_write_id, final_response, failure_code,
        created_at_ms, updated_at_ms
      FROM agent_runs;

      DROP TABLE agent_runs;
      DROP TABLE jobs;
      ALTER TABLE jobs_v5 RENAME TO jobs;
      ALTER TABLE agent_runs_v5 RENAME TO agent_runs;

      CREATE INDEX jobs_claim
        ON jobs(status, available_at_ms, inbound_sequence, created_at_ms);
      CREATE UNIQUE INDEX jobs_one_running_chat
        ON jobs(chat_id) WHERE status = 'running';
    `,
  },
];

export function runMigrations(
  db: Database.Database,
  targetVersion = MIGRATIONS.at(-1)?.version ?? 0,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
  `);

  const appliedRows = db
    .prepare<[], { version: number }>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));
  const insertVersion = db.prepare<{ version: number; applied_at_ms: number }>(
    "INSERT INTO schema_migrations(version, applied_at_ms) VALUES (@version, @applied_at_ms)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version) || migration.version > targetVersion) {
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      if (migration.rebuildsForeignKeys === true) {
        const violations = db.pragma("foreign_key_check") as readonly unknown[];
        if (violations.length > 0) {
          throw new Error(`Migration ${migration.version} violated foreign keys`);
        }
      }
      insertVersion.run({ version: migration.version, applied_at_ms: Date.now() });
    });
    if (migration.rebuildsForeignKeys !== true) {
      apply.immediate();
      continue;
    }
    const foreignKeysEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
    db.pragma("foreign_keys = OFF");
    try {
      apply.immediate();
    } finally {
      if (foreignKeysEnabled) {
        db.pragma("foreign_keys = ON");
      }
    }
  }
}

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
