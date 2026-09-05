import type { RunId, TraceId } from "../core/ids.js";

export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      providerState?: string;
      toolCalls?: readonly ModelToolCall[];
    }
  | { role: "tool"; content: string; toolCallId: string };

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface ModelResponse {
  id: string | null;
  content: string;
  providerState: string | null;
  toolCalls: readonly ModelToolCall[];
  finishReason: string | null;
  usage: ModelUsage;
}

export interface ModelRequest {
  traceId: TraceId;
  runId: RunId;
  messages: readonly ModelMessage[];
  tools: readonly ModelToolDefinition[];
  responseFormat?: "json";
  reasoningEffort?: "low" | "medium";
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ChatModel {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface MemoryMaintenanceRequest {
  traceId: TraceId;
  runId: RunId;
  messages: readonly { role: "system" | "user"; content: string }[];
  signal: AbortSignal;
}

export interface MemoryMaintenanceResponse {
  id: string | null;
  content: string;
  usage: ModelUsage;
}

export interface MemoryMaintenanceModel {
  maintainMemory(request: MemoryMaintenanceRequest): Promise<MemoryMaintenanceResponse>;
}

export class ModelProviderError extends Error {
  readonly kind: "rate_limited" | "transient" | "terminal";
  readonly status: number | undefined;
  readonly providerRequestId: string | undefined;

  constructor(input: {
    kind: ModelProviderError["kind"];
    message: string;
    status?: number;
    providerRequestId?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ModelProviderError";
    this.kind = input.kind;
    this.status = input.status;
    this.providerRequestId = input.providerRequestId;
  }
}
