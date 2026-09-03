import { randomUUID } from "node:crypto";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type TraceId = Brand<string, "TraceId">;
export type InboundId = Brand<string, "InboundId">;
export type JobId = Brand<string, "JobId">;
export type RunId = Brand<string, "RunId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type OAuthLinkId = Brand<string, "OAuthLinkId">;
export type OAuthAttemptId = Brand<string, "OAuthAttemptId">;
export type ToolExecutionId = Brand<string, "ToolExecutionId">;
export type WriteIntentId = Brand<string, "WriteIntentId">;
export type EgressId = Brand<string, "EgressId">;
export type SafeLabel = Brand<string, "SafeLabel">;

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export const newTraceId = (): TraceId => createId("tr") as TraceId;
export const newInboundId = (): InboundId => createId("in") as InboundId;
export const newJobId = (): JobId => createId("job") as JobId;
export const newRunId = (): RunId => createId("run") as RunId;
export const newConnectionId = (): ConnectionId => createId("con") as ConnectionId;
export const newOAuthLinkId = (): OAuthLinkId => createId("ol") as OAuthLinkId;
export const newOAuthAttemptId = (): OAuthAttemptId => createId("oa") as OAuthAttemptId;
export const newToolExecutionId = (): ToolExecutionId => createId("tool") as ToolExecutionId;
export const newWriteIntentId = (): WriteIntentId => createId("write") as WriteIntentId;

export function asTraceId(value: string): TraceId {
  if (!/^tr_[a-f0-9]{32}$/u.test(value)) {
    throw new Error(`Invalid trace ID: ${value}`);
  }
  return value as TraceId;
}

export function asInboundId(value: string): InboundId {
  if (!/^in_[a-f0-9]{32}$/u.test(value)) {
    throw new Error(`Invalid inbound ID: ${value}`);
  }
  return value as InboundId;
}

export function asRunId(value: string): RunId {
  if (!/^run_[a-f0-9]{32}$/u.test(value)) {
    throw new Error(`Invalid run ID: ${value}`);
  }
  return value as RunId;
}

export function asEgressId(value: string): EgressId {
  if (!/^eg_[a-f0-9]{32}$/u.test(value)) {
    throw new Error(`Invalid egress ID: ${value}`);
  }
  return value as EgressId;
}
export const newEgressId = (): EgressId => createId("eg") as EgressId;

export function asSafeLabel(value: string): SafeLabel {
  const label = value.trim();
  if (label.length === 0 || label.length > 160) {
    throw new Error("Safe labels must contain between 1 and 160 characters");
  }
  return label as SafeLabel;
}
