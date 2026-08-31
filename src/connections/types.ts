import type { ConnectionId, SafeLabel } from "../core/ids.js";
import type { TraceId } from "../core/ids.js";
import { ModelSafeError } from "../core/errors.js";

export type ConnectionProvider = "google" | "notion";
export type ConnectionStatus = "healthy" | "degraded" | "reconnect_required" | "disconnected";

export const TOOL_CAPABILITIES = [
  "gmail.search",
  "gmail.read_thread",
  "gmail.create_draft",
  "gmail.send_draft",
  "notion.search",
  "notion.fetch",
  "notion.create_page",
  "notion.update_page",
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export interface ConnectionRecord {
  id: ConnectionId;
  provider: ConnectionProvider;
  providerAccountId: string;
  safeLabel: SafeLabel;
  status: ConnectionStatus;
  credentialGeneration: number;
  healthGeneration: number;
  checkedAtMs: number | null;
  lastSuccessAtMs: number | null;
  retryAtMs: number | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  safeMetadata: Record<string, unknown>;
  providerState: Record<string, unknown>;
  capabilities: readonly ToolCapability[];
  expiresAtMs: number | null;
}

export interface ConnectionAuthorization {
  traceId: TraceId;
  provider: ConnectionProvider;
  providerAccountId: string;
  safeLabel: string;
  safeMetadata: Record<string, unknown>;
  providerState: Record<string, unknown>;
  capabilities: readonly ToolCapability[];
  credentials: Record<string, unknown>;
  expiresAtMs?: number;
  expectedConnectionId?: ConnectionId;
  expectedCredentialGeneration?: number;
}

export type ConnectionRoutingErrorCode =
  | "connection_not_found"
  | "connection_unhealthy"
  | "connection_ambiguous"
  | "capability_unavailable";

export class ConnectionRoutingError extends ModelSafeError<ConnectionRoutingErrorCode> {
  readonly labels: readonly string[];

  constructor(input: {
    code: ConnectionRoutingErrorCode;
    message: string;
    labels?: readonly string[];
  }) {
    super("ConnectionRoutingError", input.code, input.message);
    this.labels = input.labels ?? [];
  }
}

export class OAuthIdentityMismatchError extends Error {
  constructor() {
    super("The authorized provider account does not match the connection being repaired");
    this.name = "OAuthIdentityMismatchError";
  }
}

export class StaleCredentialGenerationError extends Error {
  constructor() {
    super("The connection credentials changed while an operation was in flight");
    this.name = "StaleCredentialGenerationError";
  }
}
