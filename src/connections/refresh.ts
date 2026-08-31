import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import { ModelSafeError } from "../core/errors.js";
import type { ConnectionId, TraceId } from "../core/ids.js";
import type { GoogleCredential } from "../oauth/google.js";
import { googleCapabilities } from "../oauth/google.js";
import type { NotionCredential } from "../oauth/notion.js";
import { createTracedProviderFetch, type ProviderFetch } from "../providers/fetch.js";
import type { TraceStore } from "../tracing/store.js";
import type { ConnectionRecoveryService } from "./recovery.js";
import { ConnectionStore } from "./store.js";
import { StaleCredentialGenerationError, type ConnectionRecord } from "./types.js";

const refreshAttemptCount = 3;
const refreshRetryBackoffMs = [250, 500] as const;
const refreshFinalizationSlackMs = 30_000;

const googleCredentialSchema: z.ZodType<GoogleCredential> = z.object({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1),
  expiryDateMs: z.number().int().positive().optional(),
  tokenType: z.string().min(1).optional(),
  scopes: z.array(z.string()),
});
const notionCredentialSchema: z.ZodType<NotionCredential> = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.string().min(1),
  expiresAtMs: z.number().int().positive().optional(),
  scopes: z.array(z.string()),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
});
const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    token_type: z.string().min(1).optional(),
    expires_in: z.number().int().positive().optional(),
    scope: z.string().optional(),
  })
  .loose();
const oauthErrorSchema = z.object({ error: z.string().min(1) }).loose();

interface RefreshLeaseRow {
  credential_generation: number;
  lease_token: string;
  lease_expires_at_ms: number;
  dispatch_state: "claimed" | "dispatched" | "completed" | "ambiguous";
}

export class RefreshRequiredError extends ModelSafeError<"reconnect_required"> {
  readonly connectionId: ConnectionId;

  constructor(connectionId: ConnectionId, message: string) {
    super("RefreshRequiredError", "reconnect_required", message);
    this.connectionId = connectionId;
  }
}

export class RefreshBusyError extends ModelSafeError<"refresh_in_progress"> {
  constructor() {
    super(
      "RefreshBusyError",
      "refresh_in_progress",
      "This connection is already being refreshed",
    );
  }
}

export class RefreshCoordinator {
  readonly #db: Database.Database;
  readonly #config: RuntimeConfig;
  readonly #connections: ConnectionStore;
  readonly #traces: TraceStore;
  readonly #recovery: ConnectionRecoveryService | undefined;
  readonly #fetchImpl: ProviderFetch | undefined;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    db: Database.Database;
    config: RuntimeConfig;
    connections: ConnectionStore;
    traces: TraceStore;
    recovery?: ConnectionRecoveryService;
    fetchImpl?: ProviderFetch;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#db = input.db;
    this.#config = input.config;
    this.#connections = input.connections;
    this.#traces = input.traces;
    this.#recovery = input.recovery;
    this.#fetchImpl = input.fetchImpl;
    this.#sleep = input.sleep ?? delay;
  }

  async credentials<T extends Record<string, unknown>>(
    connectionId: ConnectionId,
    traceId: TraceId,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<T> {
    const connection = this.#connections.getRequired(connectionId);
    if (connection.status === "reconnect_required" || connection.status === "disconnected") {
      throw new RefreshRequiredError(connectionId, `${connection.safeLabel} requires reconnection`);
    }
    const expiresAt = connection.expiresAtMs;
    if (expiresAt === null || expiresAt > nowMs + 60_000) {
      return this.#connections.loadCredentials<T>(connectionId);
    }
    if (connection.status === "degraded" && (connection.retryAtMs ?? 0) > nowMs) {
      if (expiresAt > nowMs) {
        return this.#connections.loadCredentials<T>(connectionId);
      }
      throw new RefreshBusyError();
    }

    const claim = this.#claim(connection, traceId, nowMs);
    if (claim.kind === "busy") {
      throw new RefreshBusyError();
    }
    if (claim.kind === "ambiguous") {
      this.#connections.markReconnectRequired({
        connectionId,
        credentialGeneration: connection.credentialGeneration,
        traceId,
        errorCode: "refresh_acceptance_unknown",
        errorSummary: "A prior token refresh may have rotated credentials before its response was saved",
      });
      this.#recovery?.planReconnect(connectionId, traceId);
      throw new RefreshRequiredError(connectionId, `${connection.safeLabel} requires reconnection`);
    }

    this.#markDispatched(connection, claim.leaseToken, traceId, nowMs);
    try {
      const refreshed =
        connection.provider === "google"
          ? await this.#refreshGoogle(connection, traceId, signal)
          : await this.#refreshNotion(connection, traceId, signal);
      try {
        const updated = this.#connections.saveAuthorization({
          traceId,
          provider: connection.provider,
          providerAccountId: connection.providerAccountId,
          safeLabel: connection.safeLabel,
          safeMetadata: connection.safeMetadata,
          providerState: refreshed.providerState,
          capabilities: refreshed.capabilities,
          credentials: refreshed.credentials,
          expiresAtMs: refreshed.expiresAtMs,
          expectedConnectionId: connection.id,
          expectedCredentialGeneration: connection.credentialGeneration,
        });
        return this.#connections.loadCredentials<T>(updated.id);
      } catch (error) {
        if (error instanceof StaleCredentialGenerationError) {
          return this.#connections.loadCredentials<T>(connection.id);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof RefreshProviderError) {
        if (error.kind === "terminal" || error.kind === "ambiguous") {
          if (error.kind === "ambiguous") {
            this.#markAmbiguous(connection.id, claim.leaseToken);
          } else {
            this.#clearLease(connection.id, claim.leaseToken);
          }
          this.#connections.markReconnectRequired({
            connectionId,
            credentialGeneration: connection.credentialGeneration,
            traceId,
            errorCode: error.code,
            errorSummary: error.message,
          });
          this.#recovery?.planReconnect(connectionId, traceId);
          throw new RefreshRequiredError(connectionId, `${connection.safeLabel} requires reconnection`);
        }
        this.#clearLease(connection.id, claim.leaseToken);
        this.#connections.markDegraded({
          connectionId,
          credentialGeneration: connection.credentialGeneration,
          traceId,
          retryAtMs: Date.now() + 60_000,
          errorCode: error.code,
          errorSummary: error.message,
        });
      }
      throw error;
    }
  }

  #claim(
    connection: ConnectionRecord,
    traceId: TraceId,
    nowMs: number,
  ): { kind: "claimed"; leaseToken: string } | { kind: "busy" } | { kind: "ambiguous" } {
    const transaction = this.#db.transaction(() => {
      const existing = this.#db
        .prepare<{ connection_id: string }, RefreshLeaseRow>(`
          SELECT credential_generation, lease_token, lease_expires_at_ms, dispatch_state
          FROM refresh_leases WHERE connection_id = @connection_id
        `)
        .get({ connection_id: connection.id });
      if (existing !== undefined) {
        if (existing.credential_generation !== connection.credentialGeneration) {
          this.#db
            .prepare<{ connection_id: string }>(
              "DELETE FROM refresh_leases WHERE connection_id = @connection_id",
            )
            .run({ connection_id: connection.id });
        } else if (
          existing.dispatch_state === "ambiguous" ||
          (existing.dispatch_state === "dispatched" && existing.lease_expires_at_ms <= nowMs)
        ) {
          this.#db
            .prepare<{ connection_id: string; now_ms: number }>(`
              UPDATE refresh_leases
              SET dispatch_state = 'ambiguous', updated_at_ms = @now_ms
              WHERE connection_id = @connection_id
            `)
            .run({ connection_id: connection.id, now_ms: nowMs });
          return { kind: "ambiguous" } as const;
        } else if (existing.lease_expires_at_ms > nowMs) {
          return { kind: "busy" } as const;
        } else {
          this.#db
            .prepare<{ connection_id: string }>(
              "DELETE FROM refresh_leases WHERE connection_id = @connection_id",
            )
            .run({ connection_id: connection.id });
        }
      }
      const leaseToken = randomUUID();
      this.#db
        .prepare<{
          connection_id: string;
          credential_generation: number;
          lease_token: string;
          lease_expires_at_ms: number;
          now_ms: number;
        }>(`
          INSERT INTO refresh_leases(
            connection_id, credential_generation, lease_token, lease_expires_at_ms,
            dispatch_state, updated_at_ms
          ) VALUES (
            @connection_id, @credential_generation, @lease_token, @lease_expires_at_ms,
            'claimed', @now_ms
          )
        `)
        .run({
          connection_id: connection.id,
          credential_generation: connection.credentialGeneration,
          lease_token: leaseToken,
          lease_expires_at_ms: nowMs + refreshLeaseDurationMs(this.#config.limits.providerRequestTimeoutMs),
          now_ms: nowMs,
        });
      this.#traces.appendInTransaction({
        traceId,
        component: "refresh",
        event: "claimed",
        outcome: connection.provider,
        data: { connectionId: connection.id, credentialGeneration: connection.credentialGeneration },
        occurredAtMs: nowMs,
      });
      return { kind: "claimed", leaseToken } as const;
    });
    return transaction.immediate();
  }

  #markDispatched(
    connection: ConnectionRecord,
    leaseToken: string,
    traceId: TraceId,
    nowMs: number,
  ): void {
    const transaction = this.#db.transaction(() => {
      const result = this.#db
        .prepare<{ connection_id: string; lease_token: string; now_ms: number }>(`
          UPDATE refresh_leases
          SET dispatch_state = 'dispatched', updated_at_ms = @now_ms
          WHERE connection_id = @connection_id AND lease_token = @lease_token
            AND dispatch_state = 'claimed'
        `)
        .run({ connection_id: connection.id, lease_token: leaseToken, now_ms: nowMs });
      if (result.changes !== 1) {
        throw new RefreshBusyError();
      }
      this.#traces.appendInTransaction({
        traceId,
        component: "refresh",
        event: "dispatched",
        outcome: connection.provider,
        data: { connectionId: connection.id, credentialGeneration: connection.credentialGeneration },
        occurredAtMs: nowMs,
      });
    });
    transaction.immediate();
  }

  async #refreshGoogle(
    connection: ConnectionRecord,
    traceId: TraceId,
    signal: AbortSignal | undefined,
  ): Promise<RefreshResult> {
    const credentials = googleCredentialSchema.parse(
      this.#connections.loadCredentials(connection.id),
    );
    const response = await this.#requestWithBoundedRetry({
      provider: "google",
      traceId,
      url: "https://oauth2.googleapis.com/token",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: this.#config.google.clientId,
        client_secret: this.#config.google.clientSecret,
      }),
      networkFailureAmbiguous: false,
      ...(signal === undefined ? {} : { signal }),
    });
    const expiresAtMs = Date.now() + (response.expires_in ?? 3_600) * 1_000;
    const scopes = response.scope === undefined ? credentials.scopes : splitScopes(response.scope);
    return {
      credentials: {
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? credentials.refreshToken,
        expiryDateMs: expiresAtMs,
        tokenType: response.token_type ?? credentials.tokenType ?? "Bearer",
        scopes,
      },
      expiresAtMs,
      providerState: { ...connection.providerState, scopes },
      capabilities: googleCapabilities(scopes),
    };
  }

  async #refreshNotion(
    connection: ConnectionRecord,
    traceId: TraceId,
    signal: AbortSignal | undefined,
  ): Promise<RefreshResult> {
    const credentials = notionCredentialSchema.parse(
      this.#connections.loadCredentials(connection.id),
    );
    const tokenEndpoint = connection.providerState.tokenEndpoint;
    if (typeof tokenEndpoint !== "string" || !URL.canParse(tokenEndpoint)) {
      throw new RefreshProviderError(
        "terminal",
        "missing_token_endpoint",
        "The Notion token endpoint is missing; reconnect this workspace",
      );
    }
    const response = await this.#requestWithBoundedRetry({
      provider: "notion",
      traceId,
      url: tokenEndpoint,
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: this.#config.notion.clientMetadataUrl,
      }),
      networkFailureAmbiguous: true,
      ...(signal === undefined ? {} : { signal }),
    });
    const expiresAtMs = Date.now() + (response.expires_in ?? 3_600) * 1_000;
    const scopes = response.scope === undefined ? credentials.scopes : splitScopes(response.scope);
    return {
      credentials: {
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? credentials.refreshToken,
        tokenType: response.token_type ?? credentials.tokenType,
        expiresAtMs,
        scopes,
        userId: credentials.userId,
        workspaceId: credentials.workspaceId,
      },
      expiresAtMs,
      providerState: { ...connection.providerState, scopes },
      capabilities: connection.capabilities,
    };
  }

  async #requestWithBoundedRetry(input: {
    provider: "google" | "notion";
    traceId: TraceId;
    url: string;
    body: URLSearchParams;
    networkFailureAmbiguous: boolean;
    signal?: AbortSignal;
  }): Promise<z.infer<typeof refreshResponseSchema>> {
    const tracedFetch = createTracedProviderFetch({
      traces: this.#traces,
      traceId: input.traceId,
      component: `${input.provider}_refresh`,
      timeoutMs: this.#config.limits.providerRequestTimeoutMs,
      ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
    });
    for (let attempt = 1; attempt <= refreshAttemptCount; attempt += 1) {
      input.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await tracedFetch(input.url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: input.body,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        if (input.signal?.aborted === true && !input.networkFailureAmbiguous) {
          throw new RefreshProviderError(
            "transient",
            "refresh_aborted",
            "The token refresh was aborted at the run deadline",
            { cause: error },
          );
        }
        if (input.networkFailureAmbiguous) {
          throw new RefreshProviderError(
            "ambiguous",
            "refresh_response_lost",
            "The refresh response was lost and may have rotated the refresh token",
            { cause: error },
          );
        }
        if (attempt < refreshAttemptCount) {
          await this.#sleep(refreshRetryBackoffMs[attempt - 1] ?? 0);
          continue;
        }
        throw new RefreshProviderError(
          "transient",
          "refresh_network_failure",
          "The token refresh network request failed",
          { cause: error },
        );
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > 1_048_576) {
        throw new RefreshProviderError("terminal", "oversized_response", "The token response was too large");
      }
      if (response.ok) {
        try {
          return refreshResponseSchema.parse(JSON.parse(text));
        } catch (error) {
          throw new RefreshProviderError(
            "terminal",
            "invalid_response",
            "The provider returned an invalid token response",
            { cause: error },
          );
        }
      }
      const errorCode = parseOAuthError(text);
      if (errorCode === "invalid_grant" || errorCode === "invalid_client") {
        throw new RefreshProviderError(
          "terminal",
          errorCode,
          "The provider rejected the stored authorization",
        );
      }
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < refreshAttemptCount) {
        await this.#sleep(refreshRetryBackoffMs[attempt - 1] ?? 0);
        continue;
      }
      const kind = [429, 500, 502, 503, 504].includes(response.status) ? "transient" : "terminal";
      throw new RefreshProviderError(
        kind,
        errorCode ?? `http_${response.status}`,
        `The provider rejected token refresh with HTTP ${response.status}`,
      );
    }
    throw new Error("Unreachable refresh retry state");
  }

  #clearLease(connectionId: ConnectionId, leaseToken: string): void {
    this.#db
      .prepare<{ connection_id: string; lease_token: string }>(`
        DELETE FROM refresh_leases
        WHERE connection_id = @connection_id AND lease_token = @lease_token
      `)
      .run({ connection_id: connectionId, lease_token: leaseToken });
  }

  #markAmbiguous(connectionId: ConnectionId, leaseToken: string): void {
    this.#db
      .prepare<{ connection_id: string; lease_token: string; now_ms: number }>(`
        UPDATE refresh_leases
        SET dispatch_state = 'ambiguous', updated_at_ms = @now_ms
        WHERE connection_id = @connection_id AND lease_token = @lease_token
      `)
      .run({ connection_id: connectionId, lease_token: leaseToken, now_ms: Date.now() });
  }
}

interface RefreshResult {
  credentials: Record<string, unknown>;
  expiresAtMs: number;
  providerState: Record<string, unknown>;
  capabilities: readonly ConnectionRecord["capabilities"][number][];
}

class RefreshProviderError extends Error {
  readonly kind: "terminal" | "transient" | "ambiguous";
  readonly code: string;

  constructor(
    kind: RefreshProviderError["kind"],
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RefreshProviderError";
    this.kind = kind;
    this.code = code;
  }
}

function parseOAuthError(text: string): string | undefined {
  try {
    const parsed = oauthErrorSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

function splitScopes(value: string): readonly string[] {
  return [...new Set(value.split(/\s+/u).map((scope) => scope.trim()).filter(Boolean))].sort();
}

function refreshLeaseDurationMs(providerRequestTimeoutMs: number): number {
  const requestBudget = refreshAttemptCount * providerRequestTimeoutMs;
  const backoffBudget = refreshRetryBackoffMs.reduce((total, milliseconds) => total + milliseconds, 0);
  return requestBudget + backoffBudget + refreshFinalizationSlackMs;
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
