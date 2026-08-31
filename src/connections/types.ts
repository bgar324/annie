import type { ConnectionId, SafeLabel } from "../core/ids.js";
import type { TraceId } from "../core/ids.js";
import { ModelSafeError } from "../core/errors.js";

export type ConnectionProvider = "google" | "notion";
export type ConnectionStatus = "healthy" | "degraded" | "reconnect_required" | "disconnected";

export const GOOGLE_CONNECTION_CAPABILITIES = [
  "gmail.read",
  "calendar.read",
  "drive.read",
  "contacts.read",
  "tasks.read",
] as const;

export const NOTION_CONNECTION_CAPABILITIES = [
  "notion.search",
  "notion.fetch",
  "notion.create_page",
  "notion.update_page",
] as const;

export const CONNECTION_CAPABILITIES = [
  ...GOOGLE_CONNECTION_CAPABILITIES,
  ...NOTION_CONNECTION_CAPABILITIES,
] as const;

export type ConnectionCapability = (typeof CONNECTION_CAPABILITIES)[number];

export function providerForCapability(capability: ConnectionCapability): ConnectionProvider {
  return capability.startsWith("notion.") ? "notion" : "google";
}

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
  capabilities: readonly ConnectionCapability[];
  expiresAtMs: number | null;
}

export interface ConnectionAuthorization {
  traceId: TraceId;
  provider: ConnectionProvider;
  providerAccountId: string;
  safeLabel: string;
  safeMetadata: Record<string, unknown>;
  providerState: Record<string, unknown>;
  capabilities: readonly ConnectionCapability[];
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
