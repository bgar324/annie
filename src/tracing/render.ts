import type { JsonlTraceEvent } from "./jsonl.js";

export function renderTrace(events: readonly JsonlTraceEvent[]): string {
  if (events.length === 0) {
    return "Trace has no events.\n";
  }

  const lines: string[] = [];
  for (const event of events) {
    const references = [
      event.providerRequestId ? `request=${event.providerRequestId}` : undefined,
      event.jobId ? `job=${event.jobId}` : undefined,
      event.runId ? `run=${event.runId}` : undefined,
      event.toolExecutionId ? `tool=${event.toolExecutionId}` : undefined,
      event.writeIntentId ? `write=${event.writeIntentId}` : undefined,
    ].filter((value): value is string => value !== undefined);
    const outcome = event.outcome ? ` [${event.outcome}]` : "";
    const referenceText = references.length === 0 ? "" : ` ${references.join(" ")}`;
    lines.push(
      `${String(event.sequence).padStart(4, "0")} ${event.occurredAt} ${event.component}.${event.event}${outcome}${referenceText}`,
    );
    if (hasData(event.data)) {
      for (const line of JSON.stringify(event.data, null, 2).split("\n")) {
        lines.push(`     ${line}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function explainTrace(events: readonly JsonlTraceEvent[]): string {
  const failure = events.findLast((event) => isFailureEvent(event));
  if (failure !== undefined) {
    const outcome = failure.outcome === undefined ? "unknown" : failure.outcome;
    return `Result: failure at sequence ${failure.sequence}: ${failure.component}.${failure.event} [${outcome}]\\n`;
  }
  const terminal = events.findLast((event) =>
    ["completed", "delivered", "succeeded"].includes(event.event),
  );
  if (terminal !== undefined) {
    return `Result: completed at sequence ${terminal.sequence}: ${terminal.component}.${terminal.event}\\n`;
  }
  return "Result: trace is incomplete; no terminal event was recorded.\\n";
}

function isFailureEvent(event: JsonlTraceEvent): boolean {
  return (
    event.event === "failed" ||
    event.event.endsWith("_failed") ||
    event.event === "blocked" ||
    event.event === "ambiguous" ||
    event.event === "delivery_unknown" ||
    event.outcome === "acceptance_unknown" ||
    event.outcome === "unresolved"
  );
}

function hasData(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}
