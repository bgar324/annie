import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RunId, TraceId } from "../core/ids.js";
import type { CredentialVault } from "../security/vault.js";
import { codexAuthSchema, type CodexAuth } from "./schema.js";

export interface WebRunRow {
  id: string;
  local_date: string;
  purpose: "daily" | "preview";
  request_id: string;
  trace_id: TraceId;
  state: "running" | "completed" | "failed" | "expired";
  lease_token_hash: string;
  lease_expires_at_ms: number;
  deadline_at_ms: number;
  credential_generation: number;
  context_json: string;
  completion_digest: string | null;
  completion_json: string | null;
  failure_code: string | null;
  returned_bytes: number;
  created_at_ms: number;
  updated_at_ms: number;
}
export interface AuthRow {
  generation: number;
  state: "ready" | "in_use" | "reauth_required";
  checked_out_run_id: string | null;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}
export class WebBriefError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) {
    super(code);
    this.name = "WebBriefError";
  }
}
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export class WebBriefStore {
  constructor(readonly db: Database.Database, readonly vault: CredentialVault) {}

  auth(): AuthRow | undefined {
    return this.db.prepare<[], AuthRow>("SELECT * FROM web_brief_auth WHERE singleton = 1").get();
  }

  saveAuth(auth: CodexAuth, generation: number): void {
    const sealed = this.vault.seal("web-brief-codex", "singleton", generation, auth);
    this.db.prepare(`INSERT INTO web_brief_auth(singleton,generation,state,checked_out_run_id,
      key_version,nonce,ciphertext,auth_tag,updated_at_ms)
      VALUES(1,@generation,'ready',NULL,@keyVersion,@nonce,@ciphertext,@authTag,@now)
      ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,state='ready',
      checked_out_run_id=NULL,key_version=excluded.key_version,nonce=excluded.nonce,
      ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,updated_at_ms=excluded.updated_at_ms
    `).run({ ...sealed, generation, now: Date.now() });
  }

  openAuth(row: AuthRow): CodexAuth {
    return codexAuthSchema.parse(this.vault.open<unknown>("web-brief-codex", "singleton", row.generation, {
      keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
    }));
  }

  byToken(token: string): WebRunRow | undefined {
    return this.db.prepare<{ hash: string }, WebRunRow>(
      "SELECT * FROM web_brief_runs WHERE lease_token_hash = @hash",
    ).get({ hash: digest(token) });
  }

  active(token: string, now = Date.now()): WebRunRow {
    const row = this.byToken(token);
    const auth = this.auth();
    if (row === undefined || row.state !== "running" || row.lease_expires_at_ms <= now || row.deadline_at_ms <= now ||
      auth?.state !== "in_use" || auth.checked_out_run_id !== row.id || auth.generation !== row.credential_generation) {
      throw new WebBriefError("stale_lease");
    }
    return row;
  }

  agentId(id: string): RunId {
    const row = this.db.prepare<{ id: string }, { id: RunId }>(
      "SELECT id FROM agent_runs WHERE web_brief_id = @id",
    ).get({ id });
    if (row === undefined) throw new WebBriefError("missing_agent_run");
    return row.id;
  }

  expire(now = Date.now()): RunId[] {
    return this.db.transaction(() => {
      const expired = this.db.prepare<{ now: number }, { id: string }>(`SELECT id FROM web_brief_runs
        WHERE state='running' AND (lease_expires_at_ms <= @now OR deadline_at_ms <= @now)`
      ).all({ now });
      const ids: RunId[] = [];
      for (const row of expired) {
        const agent = this.db.prepare<{ id: string }, { id: RunId }>("SELECT id FROM agent_runs WHERE web_brief_id=@id").get(row);
        if (agent !== undefined) ids.push(agent.id);
        this.db.prepare(`UPDATE web_brief_auth SET state='reauth_required',checked_out_run_id=NULL,
          updated_at_ms=@now WHERE state='in_use' AND checked_out_run_id=@id`).run({ id: row.id, now });
        this.db.prepare(`UPDATE web_brief_runs SET state='expired',failure_code='auth_checkout_expired',
          context_json='{}',updated_at_ms=@now WHERE id=@id AND state='running'`).run({ id: row.id, now });
        this.db.prepare(`UPDATE agent_runs SET phase='failed',failure_code='auth_checkout_expired',
          updated_at_ms=@now WHERE web_brief_id=@id AND phase='running'`).run({ id: row.id, now });
      }
      this.trim();
      return ids;
    }).immediate();
  }

  trim(): void {
    // Completed evidence retains citation/account identity, never provider source text.
    this.db.exec(`UPDATE tool_executions SET result_json=NULL,arguments_json='{}' WHERE run_id IN (
      SELECT a.id FROM agent_runs a JOIN web_brief_runs w ON w.id=a.web_brief_id WHERE w.state<>'running');
      UPDATE web_brief_sources SET value_json='{}' WHERE web_brief_id IN (SELECT id FROM web_brief_runs WHERE state<>'running');
      DELETE FROM web_brief_editions WHERE local_date NOT IN (
        SELECT local_date FROM web_brief_editions ORDER BY local_date DESC LIMIT 14);
      DELETE FROM agent_runs WHERE web_brief_id IN (
        SELECT id FROM web_brief_runs WHERE state<>'running' AND id NOT IN (
          SELECT id FROM web_brief_runs ORDER BY created_at_ms DESC LIMIT 32)
          AND id NOT IN (SELECT web_brief_id FROM web_brief_editions));
      DELETE FROM web_brief_runs WHERE state<>'running' AND id NOT IN (
        SELECT id FROM web_brief_runs ORDER BY created_at_ms DESC LIMIT 32)
        AND id NOT IN (SELECT web_brief_id FROM web_brief_editions);`);
  }
}
