import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  newOAuthLinkId,
  type ConnectionId,
  type OAuthLinkId,
  type TraceId,
} from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type { ConnectionProvider } from "../connections/types.js";

export type ConnectLinkPurpose = "connect" | "reconnect";

export interface ConnectLinkBinding {
  id: OAuthLinkId;
  provider: ConnectionProvider;
  purpose: ConnectLinkPurpose;
  expectedConnectionId: ConnectionId | null;
  traceId: TraceId;
  issuedAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
}

export interface IssuedConnectLink {
  id: OAuthLinkId;
  url: string;
  expiresAtMs: number;
}

interface LinkRow {
  id: OAuthLinkId;
  provider: ConnectionProvider;
  purpose: ConnectLinkPurpose;
  expected_connection_id: ConnectionId | null;
  trace_id: TraceId;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
}

const claimsSchema = z
  .object({
    v: z.literal(1),
    provider: z.enum(["google", "notion"]),
    jti: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

type Claims = z.infer<typeof claimsSchema>;

export class ConnectLinkError extends Error {
  readonly code: "invalid" | "expired" | "used" | "provider_mismatch";

  constructor(code: ConnectLinkError["code"], message: string) {
    super(message);
    this.name = "ConnectLinkError";
    this.code = code;
  }
}

export class ConnectLinkService {
  readonly #db: Database.Database;
  readonly #signingKey: Buffer;
  readonly #publicBaseUrl: string;
  readonly #traces: TraceStore;
  readonly #ttlMs: number;

  constructor(input: {
    db: Database.Database;
    signingKey: Buffer;
    publicBaseUrl: string;
    traces: TraceStore;
    ttlMs: number;
  }) {
    if (input.signingKey.length < 32) {
      throw new Error("Connect-link signing keys must contain at least 32 bytes");
    }
    this.#db = input.db;
    this.#signingKey = Buffer.from(input.signingKey);
    this.#publicBaseUrl = new URL(input.publicBaseUrl).origin;
    this.#traces = input.traces;
    this.#ttlMs = input.ttlMs;
  }

  issue(input: {
    provider: ConnectionProvider;
    purpose: ConnectLinkPurpose;
    traceId: TraceId;
    expectedConnectionId?: ConnectionId;
    nowMs?: number;
  }): IssuedConnectLink {
    if (input.purpose === "reconnect" && input.expectedConnectionId === undefined) {
      throw new Error("Reconnect links must be bound to a connection");
    }
    if (input.purpose === "connect" && input.expectedConnectionId !== undefined) {
      throw new Error("New connection links cannot be bound to an existing connection");
    }
    const now = input.nowMs ?? Date.now();
    const expiresAtMs = now + this.#ttlMs;
    const id = newOAuthLinkId();
    const claims: Claims = {
      v: 1,
      provider: input.provider,
      jti: randomBytes(32).toString("base64url"),
      iat: now,
      exp: expiresAtMs,
    };
    const token = this.#encode(claims);
    const transaction = this.#db.transaction(() => {
      this.#db
        .prepare<{
          id: string;
          jti_hash: string;
          provider: ConnectionProvider;
          purpose: ConnectLinkPurpose;
          expected_connection_id: string | null;
          trace_id: string;
          issued_at_ms: number;
          expires_at_ms: number;
        }>(`
          INSERT INTO oauth_link_tokens(
            id, jti_hash, provider, purpose, expected_connection_id, trace_id,
            issued_at_ms, expires_at_ms, consumed_at_ms
          ) VALUES (
            @id, @jti_hash, @provider, @purpose, @expected_connection_id, @trace_id,
            @issued_at_ms, @expires_at_ms, NULL
          )
        `)
        .run({
          id,
          jti_hash: hashJti(claims.jti),
          provider: input.provider,
          purpose: input.purpose,
          expected_connection_id: input.expectedConnectionId ?? null,
          trace_id: input.traceId,
          issued_at_ms: now,
          expires_at_ms: expiresAtMs,
        });
      this.#traces.appendInTransaction({
        traceId: input.traceId,
        component: "oauth_link",
        event: "issued",
        outcome: input.provider,
        data: {
          linkId: id,
          purpose: input.purpose,
          expectedConnectionId: input.expectedConnectionId,
          expiresAtMs,
        },
        occurredAtMs: now,
      });
    });
    transaction.immediate();
    const url = new URL(`/connect/${input.provider}`, this.#publicBaseUrl);
    url.searchParams.set("token", token);
    return { id, url: url.toString(), expiresAtMs };
  }

  resolve(token: string, expectedProvider: ConnectionProvider, nowMs = Date.now()): ConnectLinkBinding {
    const claims = this.#decode(token);
    if (claims.provider !== expectedProvider) {
      throw new ConnectLinkError("provider_mismatch", "This connection link is for another provider");
    }
    if (claims.iat > nowMs + 30_000 || claims.exp <= claims.iat || claims.exp <= nowMs) {
      throw new ConnectLinkError("expired", "This connection link has expired");
    }
    const row = this.#db
      .prepare<{ jti_hash: string }, LinkRow>(`
        SELECT id, provider, purpose, expected_connection_id, trace_id,
               issued_at_ms, expires_at_ms, consumed_at_ms
        FROM oauth_link_tokens WHERE jti_hash = @jti_hash
      `)
      .get({ jti_hash: hashJti(claims.jti) });
    if (
      row === undefined ||
      row.provider !== claims.provider ||
      row.issued_at_ms !== claims.iat ||
      row.expires_at_ms !== claims.exp
    ) {
      throw new ConnectLinkError("invalid", "This connection link is invalid");
    }
    if (row.consumed_at_ms !== null) {
      throw new ConnectLinkError("used", "This connection link has already been used");
    }
    if (row.expires_at_ms <= nowMs) {
      throw new ConnectLinkError("expired", "This connection link has expired");
    }
    return toBinding(row);
  }

  consumeInTransaction(linkId: OAuthLinkId, nowMs = Date.now()): void {
    const result = this.#db
      .prepare<{ id: string; now_ms: number }>(`
        UPDATE oauth_link_tokens
        SET consumed_at_ms = @now_ms
        WHERE id = @id AND consumed_at_ms IS NULL AND expires_at_ms > @now_ms
      `)
      .run({ id: linkId, now_ms: nowMs });
    if (result.changes !== 1) {
      throw new ConnectLinkError("used", "This connection link is expired or already used");
    }
  }

  #encode(claims: Claims): string {
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#signingKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  #decode(token: string): Claims {
    if (token.length > 2_048) {
      throw new ConnectLinkError("invalid", "This connection link is invalid");
    }
    const parts = token.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ConnectLinkError("invalid", "This connection link is invalid");
    }
    const expected = createHmac("sha256", this.#signingKey).update(parts[0]).digest();
    let received: Buffer;
    try {
      received = Buffer.from(parts[1], "base64url");
    } catch {
      throw new ConnectLinkError("invalid", "This connection link is invalid");
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new ConnectLinkError("invalid", "This connection link is invalid");
    }
    try {
      return claimsSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    } catch {
      throw new ConnectLinkError("invalid", "This connection link is invalid");
    }
  }
}

function hashJti(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}

function toBinding(row: LinkRow): ConnectLinkBinding {
  return {
    id: row.id,
    provider: row.provider,
    purpose: row.purpose,
    expectedConnectionId: row.expected_connection_id,
    traceId: row.trace_id,
    issuedAtMs: row.issued_at_ms,
    expiresAtMs: row.expires_at_ms,
    consumedAtMs: row.consumed_at_ms,
  };
}
