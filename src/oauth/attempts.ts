import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  newOAuthAttemptId,
  type ConnectionId,
  type OAuthAttemptId,
  type OAuthLinkId,
  type TraceId,
} from "../core/ids.js";
import type { CredentialVault } from "../security/vault.js";
import type { TraceStore } from "../tracing/store.js";
import type { ConnectionProvider } from "../connections/types.js";
import type { ConnectLinkBinding } from "./links.js";
import { ConnectLinkService } from "./links.js";

export type OAuthAttemptStatus =
  | "pending"
  | "exchange_started"
  | "tokens_saved"
  | "active"
  | "failed"
  | "expired";

export interface OAuthAttempt<TContext extends Record<string, unknown> = Record<string, unknown>> {
  id: OAuthAttemptId;
  linkTokenId: OAuthLinkId;
  provider: ConnectionProvider;
  expectedConnectionId: ConnectionId | null;
  traceId: TraceId;
  status: OAuthAttemptStatus;
  authorizationUrl: string;
  providerIdentity: string | null;
  failureCode: string | null;
  expiresAtMs: number;
  context: TContext;
}

interface AttemptRow {
  id: OAuthAttemptId;
  link_token_id: OAuthLinkId;
  provider: ConnectionProvider;
  expected_connection_id: ConnectionId | null;
  trace_id: TraceId;
  status: OAuthAttemptStatus;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  authorization_url: string;
  provider_identity: string | null;
  failure_code: string | null;
  expires_at_ms: number;
}

export class OAuthAttemptError extends Error {
  readonly code: "invalid_state" | "expired" | "already_processing" | "invalid_transition";

  constructor(code: OAuthAttemptError["code"], message: string) {
    super(message);
    this.name = "OAuthAttemptError";
    this.code = code;
  }
}

export class OAuthAttemptStore {
  readonly #db: Database.Database;
  readonly #links: ConnectLinkService;
  readonly #vault: CredentialVault;
  readonly #traces: TraceStore;

  constructor(input: {
    db: Database.Database;
    links: ConnectLinkService;
    vault: CredentialVault;
    traces: TraceStore;
  }) {
    this.#db = input.db;
    this.#links = input.links;
    this.#vault = input.vault;
    this.#traces = input.traces;
  }

  createOrReuse<TContext extends Record<string, unknown>>(input: {
    link: ConnectLinkBinding;
    build: (security: {
      state: string;
      codeVerifier: string;
      codeChallenge: string;
      nonce: string;
    }) => { authorizationUrl: string; context: TContext };
    nowMs?: number;
  }): OAuthAttempt<TContext & { codeVerifier: string; nonce: string }> {
    const now = input.nowMs ?? Date.now();
    const transaction = this.#db.transaction(() => {
      const existing = this.#getRowByLink(input.link.id);
      if (existing !== undefined) {
        if (existing.expires_at_ms <= now && existing.status === "pending") {
          this.#db
            .prepare<{ id: string; now_ms: number }>(`
              UPDATE oauth_attempts
              SET status = 'expired', updated_at_ms = @now_ms
              WHERE id = @id AND status = 'pending'
            `)
            .run({ id: existing.id, now_ms: now });
          throw new OAuthAttemptError("expired", "This authorization attempt has expired");
        }
        return this.#toAttempt<TContext & { codeVerifier: string; nonce: string }>(existing);
      }
      if (input.link.consumedAtMs !== null || input.link.expiresAtMs <= now) {
        throw new OAuthAttemptError("expired", "This connection link is no longer available");
      }

      const id = newOAuthAttemptId();
      const state = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(64).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const built = input.build({ state, codeVerifier, codeChallenge, nonce });
      const context = { ...built.context, codeVerifier, nonce };
      const sealed = this.#vault.seal("oauth-attempt", id, 1, context);
      this.#db
        .prepare<{
          id: string;
          link_token_id: string;
          provider: ConnectionProvider;
          expected_connection_id: string | null;
          state_hash: string;
          key_version: number;
          nonce: Buffer;
          ciphertext: Buffer;
          auth_tag: Buffer;
          authorization_url: string;
          expires_at_ms: number;
          now_ms: number;
        }>(`
          INSERT INTO oauth_attempts(
            id, link_token_id, provider, expected_connection_id, state_hash, status,
            key_version, nonce, ciphertext, auth_tag, authorization_url,
            provider_identity, failure_code, expires_at_ms, state_consumed_at_ms,
            created_at_ms, updated_at_ms
          ) VALUES (
            @id, @link_token_id, @provider, @expected_connection_id, @state_hash, 'pending',
            @key_version, @nonce, @ciphertext, @auth_tag, @authorization_url,
            NULL, NULL, @expires_at_ms, NULL, @now_ms, @now_ms
          )
        `)
        .run({
          id,
          link_token_id: input.link.id,
          provider: input.link.provider,
          expected_connection_id: input.link.expectedConnectionId,
          state_hash: hashState(state),
          key_version: sealed.keyVersion,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          auth_tag: sealed.authTag,
          authorization_url: built.authorizationUrl,
          expires_at_ms: input.link.expiresAtMs,
          now_ms: now,
        });
      this.#traces.appendInTransaction({
        traceId: input.link.traceId,
        component: "oauth",
        event: "attempt_created",
        outcome: input.link.provider,
        data: { attemptId: id, expiresAtMs: input.link.expiresAtMs },
        occurredAtMs: now,
      });
      return this.getRequired<TContext & { codeVerifier: string; nonce: string }>(id);
    });
    return transaction.immediate();
  }

  beginExchange<TContext extends Record<string, unknown>>(input: {
    provider: ConnectionProvider;
    state: string;
    nowMs?: number;
  }): { attempt: OAuthAttempt<TContext>; fresh: boolean } {
    const now = input.nowMs ?? Date.now();
    const transaction = this.#db.transaction(() => {
      const row = this.#db
        .prepare<{ state_hash: string }, AttemptRow>(`${attemptSelect} WHERE state_hash = @state_hash`)
        .get({ state_hash: hashState(input.state) });
      if (row === undefined || row.provider !== input.provider) {
        throw new OAuthAttemptError("invalid_state", "The OAuth state is invalid");
      }
      if (row.expires_at_ms <= now && row.status !== "active") {
        this.#db
          .prepare<{ id: string; now_ms: number }>(`
            UPDATE oauth_attempts SET status = 'expired', updated_at_ms = @now_ms
            WHERE id = @id AND status IN ('pending', 'exchange_started')
          `)
          .run({ id: row.id, now_ms: now });
        throw new OAuthAttemptError("expired", "The OAuth state has expired");
      }
      if (row.status !== "pending") {
        return { attempt: this.#toAttempt<TContext>(row), fresh: false };
      }
      this.#links.consumeInTransaction(row.link_token_id, now);
      const update = this.#db
        .prepare<{ id: string; now_ms: number }>(`
          UPDATE oauth_attempts
          SET status = 'exchange_started', state_consumed_at_ms = @now_ms, updated_at_ms = @now_ms
          WHERE id = @id AND status = 'pending'
        `)
        .run({ id: row.id, now_ms: now });
      if (update.changes !== 1) {
        throw new OAuthAttemptError("already_processing", "This authorization is already processing");
      }
      this.#traces.appendInTransaction({
        traceId: row.trace_id,
        component: "oauth",
        event: "exchange_started",
        outcome: input.provider,
        data: { attemptId: row.id },
        occurredAtMs: now,
      });
      return {
        attempt: this.#toAttempt<TContext>({ ...row, status: "exchange_started" }),
        fresh: true,
      };
    });
    return transaction.immediate();
  }

  saveExchangeResult(input: {
    attemptId: OAuthAttemptId;
    providerIdentity: string;
    context: Record<string, unknown>;
  }): OAuthAttempt {
    return this.#replaceContext({
      attemptId: input.attemptId,
      expectedStatus: "exchange_started",
      nextStatus: "tokens_saved",
      providerIdentity: input.providerIdentity,
      context: input.context,
      event: "tokens_saved",
    });
  }

  activate(input: {
    attemptId: OAuthAttemptId;
    connectionId: ConnectionId;
  }): OAuthAttempt<{ connectionId: ConnectionId }> {
    return this.#replaceContext({
      attemptId: input.attemptId,
      expectedStatus: "tokens_saved",
      nextStatus: "active",
      context: { connectionId: input.connectionId },
      event: "active",
    }) as OAuthAttempt<{ connectionId: ConnectionId }>;
  }

  fail(attemptId: OAuthAttemptId, failureCode: string): void {
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      const row = this.#getRow(attemptId);
      if (row === undefined || row.status === "active") {
        return;
      }
      this.#db
        .prepare<{ id: string; failure_code: string; now_ms: number }>(`
          UPDATE oauth_attempts
          SET status = 'failed', failure_code = @failure_code, updated_at_ms = @now_ms
          WHERE id = @id AND status <> 'active'
        `)
        .run({ id: attemptId, failure_code: failureCode, now_ms: now });
      this.#traces.appendInTransaction({
        traceId: row.trace_id,
        component: "oauth",
        event: "failed",
        outcome: row.provider,
        data: { attemptId, failureCode },
        occurredAtMs: now,
      });
    });
    transaction.immediate();
  }
  findByLink<TContext extends Record<string, unknown>>(
    linkId: OAuthLinkId,
  ): OAuthAttempt<TContext> | undefined {
    const row = this.#getRowByLink(linkId);
    return row === undefined ? undefined : this.#toAttempt<TContext>(row);
  }

  updateSavedContext(input: {
    attemptId: OAuthAttemptId;
    context: Record<string, unknown>;
    event: string;
  }): OAuthAttempt {
    return this.#replaceContext({
      attemptId: input.attemptId,
      expectedStatus: "tokens_saved",
      nextStatus: "tokens_saved",
      context: input.context,
      event: input.event,
    });
  }


  getRequired<TContext extends Record<string, unknown>>(
    attemptId: OAuthAttemptId,
  ): OAuthAttempt<TContext> {
    const row = this.#getRow(attemptId);
    if (row === undefined) {
      throw new Error(`Unknown OAuth attempt: ${attemptId}`);
    }
    return this.#toAttempt<TContext>(row);
  }

  #replaceContext(input: {
    attemptId: OAuthAttemptId;
    expectedStatus: OAuthAttemptStatus;
    nextStatus: OAuthAttemptStatus;
    providerIdentity?: string;
    context: Record<string, unknown>;
    event: string;
  }): OAuthAttempt {
    const now = Date.now();
    const transaction = this.#db.transaction(() => {
      const row = this.#getRow(input.attemptId);
      if (row === undefined || row.status !== input.expectedStatus) {
        throw new OAuthAttemptError(
          "invalid_transition",
          `OAuth attempt ${input.attemptId} cannot transition to ${input.nextStatus}`,
        );
      }
      const sealed = this.#vault.seal("oauth-attempt", input.attemptId, 1, input.context);
      const result = this.#db
        .prepare<{
          id: string;
          expected_status: OAuthAttemptStatus;
          next_status: OAuthAttemptStatus;
          provider_identity: string | null;
          key_version: number;
          nonce: Buffer;
          ciphertext: Buffer;
          auth_tag: Buffer;
          now_ms: number;
        }>(`
          UPDATE oauth_attempts
          SET status = @next_status, provider_identity = @provider_identity,
              key_version = @key_version, nonce = @nonce, ciphertext = @ciphertext,
              auth_tag = @auth_tag, updated_at_ms = @now_ms
          WHERE id = @id AND status = @expected_status
        `)
        .run({
          id: input.attemptId,
          expected_status: input.expectedStatus,
          next_status: input.nextStatus,
          provider_identity: input.providerIdentity ?? row.provider_identity,
          key_version: sealed.keyVersion,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          auth_tag: sealed.authTag,
          now_ms: now,
        });
      if (result.changes !== 1) {
        throw new OAuthAttemptError("invalid_transition", "The OAuth attempt changed concurrently");
      }
      this.#traces.appendInTransaction({
        traceId: row.trace_id,
        component: "oauth",
        event: input.event,
        outcome: row.provider,
        data: { attemptId: row.id, providerIdentity: input.providerIdentity },
        occurredAtMs: now,
      });
      return this.getRequired(input.attemptId);
    });
    return transaction.immediate();
  }

  #getRow(attemptId: OAuthAttemptId): AttemptRow | undefined {
    return this.#db
      .prepare<{ id: string }, AttemptRow>(`${attemptSelect} WHERE oauth_attempts.id = @id`)
      .get({ id: attemptId });
  }

  #getRowByLink(linkId: OAuthLinkId): AttemptRow | undefined {
    return this.#db
      .prepare<{ link_token_id: string }, AttemptRow>(
        `${attemptSelect} WHERE oauth_attempts.link_token_id = @link_token_id`,
      )
      .get({ link_token_id: linkId });
  }

  #toAttempt<TContext extends Record<string, unknown>>(row: AttemptRow): OAuthAttempt<TContext> {
    const context = this.#vault.open<TContext>("oauth-attempt", row.id, 1, {
      keyVersion: row.key_version,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.auth_tag,
    });
    return {
      id: row.id,
      linkTokenId: row.link_token_id,
      provider: row.provider,
      expectedConnectionId: row.expected_connection_id,
      traceId: row.trace_id,
      status: row.status,
      authorizationUrl: row.authorization_url,
      providerIdentity: row.provider_identity,
      failureCode: row.failure_code,
      expiresAtMs: row.expires_at_ms,
      context,
    };
  }
}

const attemptSelect = `
  SELECT oauth_attempts.id, oauth_attempts.link_token_id, oauth_attempts.provider,
         oauth_attempts.expected_connection_id, oauth_link_tokens.trace_id,
         oauth_attempts.status, oauth_attempts.key_version, oauth_attempts.nonce,
         oauth_attempts.ciphertext, oauth_attempts.auth_tag,
         oauth_attempts.authorization_url, oauth_attempts.provider_identity,
         oauth_attempts.failure_code, oauth_attempts.expires_at_ms
  FROM oauth_attempts
  JOIN oauth_link_tokens ON oauth_link_tokens.id = oauth_attempts.link_token_id
`;

function hashState(state: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(state)) {
    return createHash("sha256").update("invalid-state").digest("hex");
  }
  return createHash("sha256").update(state).digest("hex");
}
