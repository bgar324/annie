import type Database from "better-sqlite3";
import { canonicalJson } from "../core/json.js";
import {
  asSafeLabel,
  newConnectionId,
  type ConnectionId,
  type SafeLabel,
  type TraceId,
} from "../core/ids.js";
import type { CredentialVault } from "../security/vault.js";
import type { TraceStore } from "../tracing/store.js";
import {
  OAuthIdentityMismatchError,
  StaleCredentialGenerationError,
  type ConnectionAuthorization,
  type ConnectionProvider,
  type ConnectionRecord,
  type ConnectionStatus,
  type ToolCapability,
} from "./types.js";

interface ConnectionRow {
  id: ConnectionId;
  provider: ConnectionProvider;
  provider_account_id: string;
  safe_label: string;
  status: ConnectionStatus;
  credential_generation: number;
  health_generation: number;
  checked_at_ms: number | null;
  last_success_at_ms: number | null;
  retry_at_ms: number | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  safe_metadata_json: string;
  provider_state_json: string;
  expires_at_ms: number | null;
}


export class ConnectionStore {
  readonly #db: Database.Database;
  readonly #vault: CredentialVault;
  readonly #traces: TraceStore;

  constructor(db: Database.Database, vault: CredentialVault, traces: TraceStore) {
    this.#db = db;
    this.#vault = vault;
    this.#traces = traces;
  }

  saveAuthorization(input: ConnectionAuthorization): ConnectionRecord {
    validateAuthorization(input);
    const transaction = this.#db.transaction(() => {
      const now = Date.now();
      const expected =
        input.expectedConnectionId === undefined ? undefined : this.#getRow(input.expectedConnectionId);
      if (
        input.expectedConnectionId !== undefined &&
        (expected === undefined ||
          expected.provider !== input.provider ||
          expected.provider_account_id !== input.providerAccountId)
      ) {
        throw new OAuthIdentityMismatchError();
      }
      const byIdentity = this.#db
        .prepare<
          { provider: ConnectionProvider; provider_account_id: string },
          Pick<ConnectionRow, "id">
        >(`
          SELECT id FROM connections
          WHERE provider = @provider AND provider_account_id = @provider_account_id
        `)
        .get({ provider: input.provider, provider_account_id: input.providerAccountId });
      if (
        expected !== undefined &&
        byIdentity !== undefined &&
        byIdentity.id !== expected.id
      ) {
        throw new OAuthIdentityMismatchError();
      }

      const connectionId = expected?.id ?? byIdentity?.id ?? newConnectionId();
      const existing = expected ?? (byIdentity === undefined ? undefined : this.#getRow(byIdentity.id));
      if (
        input.expectedCredentialGeneration !== undefined &&
        existing?.credential_generation !== input.expectedCredentialGeneration
      ) {
        throw new StaleCredentialGenerationError();
      }
      const credentialGeneration = (existing?.credential_generation ?? 0) + 1;
      const healthGeneration =
        existing === undefined
          ? 1
          : existing.status === "healthy"
            ? existing.health_generation
            : existing.health_generation + 1;
      const safeLabel = this.#allocateSafeLabel(input.provider, input.safeLabel, connectionId);
      const sealed = this.#vault.seal(
        "connection-secret",
        `${input.provider}:${connectionId}`,
        credentialGeneration,
        input.credentials,
      );

      this.#db
        .prepare<{
          id: string;
          provider: ConnectionProvider;
          provider_account_id: string;
          safe_label: string;
          normalized_safe_label: string;
          credential_generation: number;
          health_generation: number;
          safe_metadata_json: string;
          provider_state_json: string;
          now_ms: number;
        }>(`
          INSERT INTO connections(
            id, provider, provider_account_id, safe_label, normalized_safe_label,
            status, credential_generation, health_generation, checked_at_ms,
            last_success_at_ms, retry_at_ms, last_error_code, last_error_summary,
            safe_metadata_json, provider_state_json, created_at_ms, updated_at_ms
          ) VALUES (
            @id, @provider, @provider_account_id, @safe_label, @normalized_safe_label,
            'healthy', @credential_generation, @health_generation, @now_ms,
            @now_ms, NULL, NULL, NULL,
            @safe_metadata_json, @provider_state_json, @now_ms, @now_ms
          )
          ON CONFLICT(id) DO UPDATE SET
            safe_label = excluded.safe_label,
            normalized_safe_label = excluded.normalized_safe_label,
            status = 'healthy',
            credential_generation = excluded.credential_generation,
            health_generation = excluded.health_generation,
            checked_at_ms = excluded.checked_at_ms,
            last_success_at_ms = excluded.last_success_at_ms,
            retry_at_ms = NULL,
            last_error_code = NULL,
            last_error_summary = NULL,
            safe_metadata_json = excluded.safe_metadata_json,
            provider_state_json = excluded.provider_state_json,
            updated_at_ms = excluded.updated_at_ms
        `)
        .run({
          id: connectionId,
          provider: input.provider,
          provider_account_id: input.providerAccountId,
          safe_label: safeLabel,
          normalized_safe_label: normalizeSafeLabel(safeLabel),
          credential_generation: credentialGeneration,
          health_generation: healthGeneration,
          safe_metadata_json: canonicalJson(input.safeMetadata),
          provider_state_json: canonicalJson(input.providerState),
          now_ms: now,
        });
      this.#db
        .prepare<{ connection_id: string }>(
          "DELETE FROM connection_capabilities WHERE connection_id = @connection_id",
        )
        .run({ connection_id: connectionId });
      const insertCapability = this.#db.prepare<{
        connection_id: string;
        capability: ToolCapability;
      }>(`
        INSERT INTO connection_capabilities(connection_id, capability)
        VALUES (@connection_id, @capability)
      `);
      for (const capability of [...new Set(input.capabilities)].sort()) {
        insertCapability.run({ connection_id: connectionId, capability });
      }
      this.#db
        .prepare<{
          connection_id: string;
          key_version: number;
          credential_generation: number;
          nonce: Buffer;
          ciphertext: Buffer;
          auth_tag: Buffer;
          expires_at_ms: number | null;
          now_ms: number;
        }>(`
          INSERT INTO connection_secrets(
            connection_id, key_version, credential_generation, nonce, ciphertext,
            auth_tag, expires_at_ms, updated_at_ms
          ) VALUES (
            @connection_id, @key_version, @credential_generation, @nonce, @ciphertext,
            @auth_tag, @expires_at_ms, @now_ms
          )
          ON CONFLICT(connection_id) DO UPDATE SET
            key_version = excluded.key_version,
            credential_generation = excluded.credential_generation,
            nonce = excluded.nonce,
            ciphertext = excluded.ciphertext,
            auth_tag = excluded.auth_tag,
            expires_at_ms = excluded.expires_at_ms,
            updated_at_ms = excluded.updated_at_ms
        `)
        .run({
          connection_id: connectionId,
          key_version: sealed.keyVersion,
          credential_generation: credentialGeneration,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          auth_tag: sealed.authTag,
          expires_at_ms: input.expiresAtMs ?? null,
          now_ms: now,
        });
      this.#db
        .prepare<{ connection_id: string }>(
          "DELETE FROM refresh_leases WHERE connection_id = @connection_id",
        )
        .run({ connection_id: connectionId });
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "connection",
        event: existing === undefined ? "connected" : "reauthorized",
        outcome: input.provider,
        data: {
          connectionId,
          safeLabel,
          credentialGeneration,
          capabilities: input.capabilities,
        },
        occurredAtMs: now,
      });
      return this.getRequired(connectionId);
    });
    return transaction.immediate();
  }

  loadCredentials<T extends Record<string, unknown>>(connectionId: ConnectionId): T {
    const connection = this.#getRow(connectionId);
    if (connection === undefined) {
      throw new Error(`Unknown connection: ${connectionId}`);
    }
    const row = this.#db
      .prepare<{ connection_id: string }, {
        key_version: number;
        credential_generation: number;
        nonce: Buffer;
        ciphertext: Buffer;
        auth_tag: Buffer;
      }>(`
        SELECT key_version, credential_generation, nonce, ciphertext, auth_tag
        FROM connection_secrets WHERE connection_id = @connection_id
      `)
      .get({ connection_id: connectionId });
    if (row === undefined || row.credential_generation !== connection.credential_generation) {
      throw new Error(`Credential generation mismatch for connection ${connectionId}`);
    }
    return this.#vault.open<T>(
      "connection-secret",
      `${connection.provider}:${connectionId}`,
      row.credential_generation,
      {
        keyVersion: row.key_version,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
      },
    );
  }

  get(connectionId: ConnectionId): ConnectionRecord | undefined {
    const row = this.#getRow(connectionId);
    return row === undefined ? undefined : this.#toRecord(row);
  }

  getRequired(connectionId: ConnectionId): ConnectionRecord {
    const connection = this.get(connectionId);
    if (connection === undefined) {
      throw new Error(`Unknown connection: ${connectionId}`);
    }
    return connection;
  }

  list(provider?: ConnectionProvider): readonly ConnectionRecord[] {
    const rows = provider === undefined
      ? this.#db.prepare<[], ConnectionRow>(`${connectionSelect} ORDER BY provider, safe_label`).all()
      : this.#db
          .prepare<{ provider: ConnectionProvider }, ConnectionRow>(
            `${connectionSelect} WHERE connections.provider = @provider ORDER BY safe_label`,
          )
          .all({ provider });
    return rows.map((row) => this.#toRecord(row));
  }

  markHealthy(input: {
    connectionId: ConnectionId;
    credentialGeneration: number;
    traceId: TraceId;
    providerState?: Record<string, unknown>;
  }): boolean {
    return this.#transitionHealth({
      ...input,
      status: "healthy",
      retryAtMs: null,
      errorCode: null,
      errorSummary: null,
    });
  }

  markDegraded(input: {
    connectionId: ConnectionId;
    credentialGeneration: number;
    traceId: TraceId;
    retryAtMs: number;
    errorCode: string;
    errorSummary: string;
  }): boolean {
    return this.#transitionHealth({ ...input, status: "degraded" });
  }

  markReconnectRequired(input: {
    connectionId: ConnectionId;
    credentialGeneration: number;
    traceId: TraceId;
    errorCode: string;
    errorSummary: string;
  }): boolean {
    return this.#transitionHealth({
      ...input,
      status: "reconnect_required",
      retryAtMs: null,
    });
  }

  disconnect(input: { connectionId: ConnectionId; traceId: TraceId; reason: string }): boolean {
    const connection = this.get(input.connectionId);
    if (connection === undefined) {
      return false;
    }
    return this.#transitionHealth({
      connectionId: input.connectionId,
      credentialGeneration: connection.credentialGeneration,
      traceId: input.traceId,
      status: "disconnected",
      retryAtMs: null,
      errorCode: "disconnected",
      errorSummary: input.reason,
    });
  }

  #transitionHealth(input: {
    connectionId: ConnectionId;
    credentialGeneration: number;
    traceId: TraceId;
    status: ConnectionStatus;
    retryAtMs: number | null;
    errorCode: string | null;
    errorSummary: string | null;
    providerState?: Record<string, unknown>;
  }): boolean {
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      const current = this.#getRow(input.connectionId);
      if (current === undefined || current.credential_generation !== input.credentialGeneration) {
        return false;
      }
      const nextHealthGeneration =
        current.status === input.status ? current.health_generation : current.health_generation + 1;
      const result = this.#db
        .prepare<{
          id: string;
          credential_generation: number;
          status: ConnectionStatus;
          health_generation: number;
          retry_at_ms: number | null;
          error_code: string | null;
          error_summary: string | null;
          provider_state_json: string;
          success_at_ms: number | null;
          now_ms: number;
        }>(`
          UPDATE connections
          SET status = @status,
              health_generation = @health_generation,
              checked_at_ms = @now_ms,
              last_success_at_ms = COALESCE(@success_at_ms, last_success_at_ms),
              retry_at_ms = @retry_at_ms,
              last_error_code = @error_code,
              last_error_summary = @error_summary,
              provider_state_json = @provider_state_json,
              updated_at_ms = @now_ms
          WHERE id = @id AND credential_generation = @credential_generation
        `)
        .run({
          id: input.connectionId,
          credential_generation: input.credentialGeneration,
          status: input.status,
          health_generation: nextHealthGeneration,
          retry_at_ms: input.retryAtMs,
          error_code: input.errorCode,
          error_summary: input.errorSummary,
          provider_state_json: canonicalJson(input.providerState ?? parseObject(current.provider_state_json)),
          success_at_ms: input.status === "healthy" ? now : null,
          now_ms: now,
        });
      if (result.changes !== 1) {
        return false;
      }
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "connection",
        event: "health_changed",
        outcome: input.status,
        data: {
          connectionId: input.connectionId,
          safeLabel: current.safe_label,
          healthGeneration: nextHealthGeneration,
          errorCode: input.errorCode,
          retryAtMs: input.retryAtMs,
        },
        occurredAtMs: now,
      });
      return true;
    });
    return transaction.immediate();
  }

  #allocateSafeLabel(
    provider: ConnectionProvider,
    requested: string,
    connectionId: ConnectionId,
  ): SafeLabel {
    const root = asSafeLabel(requested);
    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = suffix === 1 ? root : asSafeLabel(`${root} (${suffix})`);
      const collision = this.#db
        .prepare<
          { provider: ConnectionProvider; normalized: string; id: string },
          { id: string }
        >(`
          SELECT id FROM connections
          WHERE provider = @provider AND normalized_safe_label = @normalized AND id <> @id
        `)
        .get({ provider, normalized: normalizeSafeLabel(candidate), id: connectionId });
      if (collision === undefined) {
        return candidate;
      }
    }
    throw new Error("Unable to allocate a unique safe connection label");
  }

  #getRow(connectionId: ConnectionId): ConnectionRow | undefined {
    return this.#db
      .prepare<{ id: string }, ConnectionRow>(`${connectionSelect} WHERE connections.id = @id`)
      .get({ id: connectionId });
  }

  #toRecord(row: ConnectionRow): ConnectionRecord {
    const capabilities = this.#db
      .prepare<{ connection_id: string }, { capability: ToolCapability }>(`
        SELECT capability FROM connection_capabilities
        WHERE connection_id = @connection_id ORDER BY capability
      `)
      .all({ connection_id: row.id })
      .map((item) => item.capability);
    return {
      id: row.id,
      provider: row.provider,
      providerAccountId: row.provider_account_id,
      safeLabel: asSafeLabel(row.safe_label),
      status: row.status,
      credentialGeneration: row.credential_generation,
      healthGeneration: row.health_generation,
      checkedAtMs: row.checked_at_ms,
      lastSuccessAtMs: row.last_success_at_ms,
      retryAtMs: row.retry_at_ms,
      lastErrorCode: row.last_error_code,
      lastErrorSummary: row.last_error_summary,
      safeMetadata: parseObject(row.safe_metadata_json),
      providerState: parseObject(row.provider_state_json),
      capabilities,
      expiresAtMs: row.expires_at_ms,
    };
  }
}

const connectionSelect = `
  SELECT connections.id, connections.provider, connections.provider_account_id,
         connections.safe_label, connections.status, connections.credential_generation,
         connections.health_generation, connections.checked_at_ms,
         connections.last_success_at_ms, connections.retry_at_ms,
         connections.last_error_code, connections.last_error_summary,
         connections.safe_metadata_json, connections.provider_state_json,
         connection_secrets.expires_at_ms
  FROM connections
  LEFT JOIN connection_secrets ON connection_secrets.connection_id = connections.id
`;

function validateAuthorization(input: ConnectionAuthorization): void {
  const providerPrefix = input.provider === "google" ? "gmail." : "notion.";
  if (input.providerAccountId.length === 0 || input.providerAccountId.length > 512) {
    throw new Error("Provider account IDs must contain between 1 and 512 characters");
  }
  if (input.capabilities.some((capability) => !capability.startsWith(providerPrefix))) {
    throw new Error(`A ${input.provider} connection contains a capability for another provider`);
  }
}

export function normalizeSafeLabel(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a stored JSON object");
  }
  return value as Record<string, unknown>;
}
