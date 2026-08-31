import type Database from "better-sqlite3";
import type { TraceId } from "./core/ids.js";

export interface ReplayTranscriptEntry {
  sequence: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  providerState: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
}

export interface MockedReplayTool {
  sequence: number;
  toolCallId: string;
  toolName: string;
  operationClass: "read" | "write";
  status: string;
  arguments: unknown;
  result: unknown;
}

export interface SafeReplayReport {
  mode: "mock_only";
  traceId: TraceId;
  runId: string;
  runPhase: string;
  finalResponse: string | null;
  failureCode: string | null;
  transcript: readonly ReplayTranscriptEntry[];
  mockedTools: readonly MockedReplayTool[];
  providerCallsMade: 0;
  credentialDecryptions: 0;
}

interface ReplayRunRow {
  id: string;
  phase: string;
  final_response: string | null;
  failure_code: string | null;
}

interface ReplayMessageRow {
  sequence: number;
  role: ReplayTranscriptEntry["role"];
  content: string;
  provider_state: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
}

interface ReplayToolRow {
  sequence: number;
  tool_call_id: string;
  tool_name: string;
  operation_class: "read" | "write";
  status: string;
  arguments_json: string;
  result_json: string | null;
}

export function buildSafeReplay(db: Database.Database, traceId: TraceId): SafeReplayReport {
  const run = db
    .prepare<{ trace_id: string }, ReplayRunRow>(`
      SELECT id, phase, final_response, failure_code
      FROM agent_runs
      WHERE trace_id = @trace_id
    `)
    .get({ trace_id: traceId });
  if (run === undefined) {
    throw new Error(`Trace ${traceId} has no agent run to replay`);
  }
  const transcript = db
    .prepare<{ run_id: string }, ReplayMessageRow>(`
      SELECT sequence, role, content, reasoning_content AS provider_state, tool_calls_json, tool_call_id
      FROM agent_messages
      WHERE run_id = @run_id
      ORDER BY sequence
    `)
    .all({ run_id: run.id })
    .map(
      (message): ReplayTranscriptEntry => ({
        sequence: message.sequence,
        role: message.role,
        content: message.content,
        providerState: message.provider_state,
        toolCalls: parseNullableJson(message.tool_calls_json),
        toolCallId: message.tool_call_id,
      }),
    );
  const mockedTools = db
    .prepare<{ run_id: string }, ReplayToolRow>(`
      SELECT ROW_NUMBER() OVER (ORDER BY created_at_ms, id) AS sequence,
             tool_call_id, tool_name, operation_class, status,
             arguments_json, result_json
      FROM tool_executions
      WHERE run_id = @run_id
      ORDER BY created_at_ms, id
    `)
    .all({ run_id: run.id })
    .map(
      (tool): MockedReplayTool => ({
        sequence: tool.sequence,
        toolCallId: tool.tool_call_id,
        toolName: tool.tool_name,
        operationClass: tool.operation_class,
        status: tool.status,
        arguments: JSON.parse(tool.arguments_json) as unknown,
        result:
          tool.result_json === null
            ? { error: { code: "captured_result_unavailable" } }
            : (JSON.parse(tool.result_json) as unknown),
      }),
    );
  return {
    mode: "mock_only",
    traceId,
    runId: run.id,
    runPhase: run.phase,
    finalResponse: run.final_response,
    failureCode: run.failure_code,
    transcript,
    mockedTools,
    providerCallsMade: 0,
    credentialDecryptions: 0,
  };
}

export function renderSafeReplay(report: SafeReplayReport): string {
  const lines = [
    `Safe replay ${report.traceId}`,
    `mode=${report.mode} provider_calls=${report.providerCallsMade} credential_decryptions=${report.credentialDecryptions}`,
    `run=${report.runId} phase=${report.runPhase}${
      report.failureCode === null ? "" : ` failure=${report.failureCode}`
    }`,
    "",
    "Captured transcript:",
  ];
  for (const message of report.transcript) {
    const toolCall = message.toolCallId === null ? "" : ` tool_call=${message.toolCallId}`;
    lines.push(`${String(message.sequence).padStart(3, "0")} ${message.role}${toolCall}: ${message.content}`);
  }
  lines.push("", "Mock tool outcomes:");
  if (report.mockedTools.length === 0) {
    lines.push("(none)");
  } else {
    for (const tool of report.mockedTools) {
      lines.push(
        `${String(tool.sequence).padStart(3, "0")} ${tool.toolName} (${tool.operationClass}) status=${tool.status}`,
      );
      lines.push(`    ${JSON.stringify(tool.result)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseNullableJson(value: string | null): unknown {
  return value === null ? null : (JSON.parse(value) as unknown);
}
