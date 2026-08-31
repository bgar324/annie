import type Database from "better-sqlite3";
import type { AgentLoop } from "../agent/loop.js";
import { buildAssistantSystemPrompt } from "../agent/prompt.js";
import type { AgentRunRecord, AgentRunStore } from "../agent/store.js";
import type { RuntimeConfig } from "../config.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionRecord } from "../connections/types.js";
import { newTraceId, type JobId, type RunId, type TraceId } from "../core/ids.js";
import type { MemoryDocumentStore } from "../memory/document.js";
import type { MemoryMaintenanceService } from "../memory/maintenance.js";
import {
  QueueCapacityError,
  type ClaimedJob,
  type QueueStore,
} from "../queue/store.js";
import type { JobContext } from "../queue/worker.js";
import type { TraceProjector } from "../tracing/jsonl.js";
import type { TraceStore } from "../tracing/store.js";
import type { EgressSendPolicy, MessageEgressService } from "./egress.js";
import type { FailureNotificationService } from "./failure.js";

const briefHour = 8;
const catchUpWindowMs = 2 * 60 * 60 * 1_000;
const egressDispatchGraceMs = 5 * 60 * 1_000;
const schedulerPollMs = 60_000;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const dailyBriefToolNames = [
  "gmail.search",
  "gmail.read_thread",
  "notion.search",
  "notion.fetch",
] as const;

interface DailyBriefPayload {
  localDate: string;
  scheduledForMs: number;
}

interface ScheduledJobRow {
  id: JobId;
  trace_id: TraceId;
  available_at_ms: number;
}

interface FailedScheduledJobRow {
  id: JobId;
  trace_id: TraceId;
  available_at_ms: number;
}

interface SearchExecutionRow {
  connection_id: string | null;
  tool_name: string;
  arguments_json: string;
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

export type DailyBriefScheduleResult =
  | { kind: "disabled" }
  | { kind: "deferred"; localDate: string; scheduledForMs: number }
  | {
      kind: "existing" | "scheduled";
      jobId: JobId;
      traceId: TraceId;
      localDate: string;
      scheduledForMs: number;
    };

export class DailyBriefService {
  readonly #db: Database.Database;
  readonly #config: RuntimeConfig;
  readonly #agent: AgentLoop;
  readonly #runs: AgentRunStore;
  readonly #memory: MemoryDocumentStore;
  readonly #maintenance: MemoryMaintenanceService;
  readonly #connections: ConnectionStore;
  readonly #egress: MessageEgressService;
  readonly #failures: FailureNotificationService;
  readonly #queue: QueueStore;
  readonly #traces: TraceStore;
  readonly #projector: TraceProjector;
  readonly #formatter: Intl.DateTimeFormat;

  constructor(input: {
    db: Database.Database;
    config: RuntimeConfig;
    agent: AgentLoop;
    runs: AgentRunStore;
    memory: MemoryDocumentStore;
    maintenance: MemoryMaintenanceService;
    connections: ConnectionStore;
    egress: MessageEgressService;
    failures: FailureNotificationService;
    queue: QueueStore;
    traces: TraceStore;
    projector: TraceProjector;
  }) {
    this.#db = input.db;
    this.#config = input.config;
    this.#agent = input.agent;
    this.#runs = input.runs;
    this.#memory = input.memory;
    this.#maintenance = input.maintenance;
    this.#connections = input.connections;
    this.#egress = input.egress;
    this.#failures = input.failures;
    this.#queue = input.queue;
    this.#traces = input.traces;
    this.#projector = input.projector;
    this.#formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: input.config.dailyBrief.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.reconcile();
      await waitFor(schedulerPollMs, signal);
    }
  }

  reconcile(nowMs = Date.now()): DailyBriefScheduleResult {
    this.#recoverFailedJobs(nowMs);
    if (!this.#config.dailyBrief.enabled) {
      return { kind: "disabled" };
    }
    const nowLocal = this.#localDateTime(nowMs);
    const today = asLocalDate(nowLocal);
    const todayLabel = formatLocalDate(today);
    const todayAtMs = this.#epochForLocalHour(today, briefHour);
    const existingToday = this.#findScheduled(todayLabel);
    const target =
      nowMs < todayAtMs || (existingToday === undefined && nowMs < todayAtMs + catchUpWindowMs)
        ? { localDate: todayLabel, scheduledForMs: todayAtMs }
        : (() => {
            const tomorrow = nextLocalDate(today);
            return {
              localDate: formatLocalDate(tomorrow),
              scheduledForMs: this.#epochForLocalHour(tomorrow, briefHour),
            };
          })();
    const existing = this.#findScheduled(target.localDate);
    if (existing !== undefined) {
      return {
        kind: "existing",
        jobId: existing.id,
        traceId: existing.trace_id,
        localDate: target.localDate,
        scheduledForMs: existing.available_at_ms,
      };
    }

    try {
      const traceId = newTraceId();
      const transaction = this.#db.transaction(() => {
        const concurrent = this.#findScheduled(target.localDate);
        if (concurrent !== undefined) {
          return {
            kind: "existing" as const,
            jobId: concurrent.id,
            traceId: concurrent.trace_id,
            localDate: target.localDate,
            scheduledForMs: concurrent.available_at_ms,
          };
        }
        this.#traces.appendInTransaction({
          traceId,
          component: "daily_brief",
          event: "scheduled",
          outcome: target.localDate,
          data: {
            localDate: target.localDate,
            scheduledForMs: target.scheduledForMs,
            timeZone: this.#config.dailyBrief.timeZone,
          },
          occurredAtMs: nowMs,
        });
        const jobId = this.#queue.enqueueInTransaction({
          chatId: this.#config.userPhoneNumber,
          type: "daily_brief",
          subjectId: target.localDate,
          payload: target,
          traceId,
          availableAtMs: target.scheduledForMs,
        });
        return {
          kind: "scheduled" as const,
          jobId,
          traceId,
          localDate: target.localDate,
          scheduledForMs: target.scheduledForMs,
        };
      });
      const result = transaction.immediate();
      if (result.kind === "scheduled") {
        try {
          this.#projector.project(result.traceId);
        } catch {
          // The durable spool is projected by the worker or repaired at startup.
        }
      }
      return result;
    } catch (error) {
      if (error instanceof QueueCapacityError) {
        return { kind: "deferred", ...target };
      }
      throw error;
    }
  }

  async handle(job: ClaimedJob, context: JobContext): Promise<void> {
    if (job.type !== "daily_brief") {
      throw new Error(`DailyBriefService cannot handle ${job.type}`);
    }
    const payload = dailyBriefPayload(job.payload);
    if (payload.localDate !== job.subjectId) {
      throw new Error("Daily brief job identity does not match its local date");
    }
    context.assertLease();
    if (!this.#config.dailyBrief.enabled) {
      this.#failActiveRun(job.id, "daily_brief_disabled");
      this.#traces.append({
        traceId: job.traceId,
        component: "daily_brief",
        event: "skipped",
        outcome: "disabled",
        jobId: job.id,
        data: { localDate: payload.localDate },
      });
      this.#traces.markTerminal(job.traceId);
      return;
    }
    if (!this.#isFresh(payload, context.nowMs())) {
      this.#failActiveRun(job.id, "daily_brief_stale");
      this.#traces.append({
        traceId: job.traceId,
        component: "daily_brief",
        event: "skipped",
        outcome: "stale",
        jobId: job.id,
        data: {
          localDate: payload.localDate,
          scheduledForMs: payload.scheduledForMs,
        },
      });
      this.#traces.markTerminal(job.traceId);
      return;
    }

    const sources = dailyBriefSources(this.#connections.list());
    if (sources.length === 0) {
      this.#traces.append({
        traceId: job.traceId,
        component: "daily_brief",
        event: "source_check",
        outcome: "none_available",
        jobId: job.id,
        data: { localDate: payload.localDate },
      });
      this.#egress.planReply({
        traceId: job.traceId,
        recipient: this.#config.userPhoneNumber,
        text: `good morning — i can’t build your daily brief until an account is connected. send ‘connect google’ for gmail or ‘connect notion’, then send ‘connections’ to verify it. trace: ${job.traceId}`,
        sendPolicy: this.#sendPolicy(payload.scheduledForMs),
      });
      return;
    }

    const request = dailyBriefRequest(
      payload,
      this.#config.dailyBrief.timeZone,
      sources,
    );
    try {
      const memory = await this.#memory.load();
      const result = await this.#agent.execute({
        source: { kind: "daily_brief", jobId: job.id },
        traceId: job.traceId,
        initialMessages: [
          {
            role: "system",
            content: buildAssistantSystemPrompt({
              memory,
              connections: this.#connections.list(),
            }),
          },
          { role: "user", content: request },
        ],
        allowedToolNames: dailyBriefToolNames,
        completionGuard: ({ runId }) =>
          this.#coverageFailure(runId, job.traceId, sources),
        jobLease: { jobId: job.id, leaseToken: job.leaseToken },
      });
      context.assertLease();
      if (result.outcome !== "completed") {
        this.#failures.plan({
          traceId: job.traceId,
          failureCode: result.run.failureCode ?? "bounded",
          runId: result.run.id,
          sendPolicy: this.#sendPolicy(payload.scheduledForMs, result.run),
        });
        return;
      }
      await this.#maintenance.maintain({
        runId: result.run.id,
        traceId: job.traceId,
        userMessage: request,
        finalResponse: result.response,
        toolOutcomes: this.#toolOutcomes(result.run.id),
      });
      context.assertLease();
      this.#egress.planReply({
        traceId: job.traceId,
        recipient: this.#config.userPhoneNumber,
        text: result.response,
        runId: result.run.id,
        sendPolicy: this.#sendPolicy(payload.scheduledForMs, result.run),
      });
    } catch (error) {
      context.assertLease();
      const run = this.#runForJob(job.id);
      if (run !== undefined && (run.phase === "running" || run.phase === "finalizing")) {
        this.#runs.fail(run.id, "unhandled_daily_brief_failure");
      }
      this.#traces.append({
        traceId: job.traceId,
        component: "daily_brief",
        event: "turn_failed",
        outcome: error instanceof Error ? error.name : "UnknownError",
        jobId: job.id,
        runId: run?.id,
        data: { error: error instanceof Error ? error.message : "Unknown daily brief failure" },
      });
      this.#failures.plan({
        traceId: job.traceId,
        failureCode: "unhandled_daily_brief_failure",
        ...(run === undefined ? {} : { runId: run.id }),
        sendPolicy: this.#sendPolicy(payload.scheduledForMs, run),
      });
    }
  }

  #recoverFailedJobs(nowMs: number): void {
    const rows = this.#db
      .prepare<[], FailedScheduledJobRow>(`
        SELECT jobs.id, jobs.trace_id, jobs.available_at_ms
        FROM jobs
        WHERE jobs.type = 'daily_brief' AND jobs.status = 'failed'
          AND NOT EXISTS (
            SELECT 1 FROM egress_messages WHERE egress_messages.trace_id = jobs.trace_id
          )
        ORDER BY jobs.available_at_ms
      `)
      .all();
    for (const row of rows) {
      const run = this.#failActiveRun(row.id, "daily_brief_job_failed");
      this.#failures.plan({
        traceId: row.trace_id,
        failureCode: "daily_brief_job_failed",
        ...(run === undefined ? {} : { runId: run.id }),
        sendPolicy: this.#sendPolicy(row.available_at_ms, run),
      });
      this.#traces.append({
        traceId: row.trace_id,
        component: "daily_brief",
        event: "failure_recovered",
        outcome: "job_failed",
        jobId: row.id,
        runId: run?.id,
        data: { recoveredAtMs: nowMs },
        occurredAtMs: nowMs,
      });
    }
  }

  #failActiveRun(jobId: JobId, failureCode: string): AgentRunRecord | undefined {
    const run = this.#runForJob(jobId);
    if (run !== undefined && (run.phase === "running" || run.phase === "finalizing")) {
      this.#runs.fail(run.id, failureCode);
      return this.#runs.getRequired(run.id);
    }
    return run;
  }

  #isFresh(payload: DailyBriefPayload, nowMs: number): boolean {
    const currentLocalDate = formatLocalDate(asLocalDate(this.#localDateTime(nowMs)));
    return (
      payload.localDate === currentLocalDate &&
      nowMs < payload.scheduledForMs + catchUpWindowMs
    );
  }

  #sendPolicy(scheduledForMs: number, run?: AgentRunRecord): EgressSendPolicy {
    return {
      kind: "daily_brief",
      expiresAtMs: Math.max(
        scheduledForMs + catchUpWindowMs,
        run === undefined ? 0 : run.deadlineAtMs + egressDispatchGraceMs,
      ),
    };
  }

  #coverageFailure(
    runId: RunId,
    traceId: TraceId,
    sources: readonly ConnectionRecord[],
  ): string | undefined {
    const executions = this.#db
      .prepare<{ run_id: string }, SearchExecutionRow>(`
        SELECT connection_id, tool_name, arguments_json
        FROM tool_executions
        WHERE run_id = @run_id AND status IN ('succeeded', 'failed')
          AND tool_name IN ('gmail.search', 'notion.search')
      `)
      .all({ run_id: runId });
    const covered = new Set<string>();
    for (const execution of executions) {
      const label = exactSearchLabel(execution.tool_name, execution.arguments_json);
      if (label === undefined || execution.connection_id === null) {
        continue;
      }
      const source = sources.find(
        (candidate) =>
          candidate.id === execution.connection_id &&
          candidate.safeLabel === label &&
          ((candidate.provider === "google" && execution.tool_name === "gmail.search") ||
            (candidate.provider === "notion" && execution.tool_name === "notion.search")),
      );
      if (source !== undefined) {
        covered.add(source.id);
      }
    }
    const missing = sources.filter((source) => !covered.has(source.id));
    if (missing.length === 0) {
      return undefined;
    }
    this.#traces.append({
      traceId,
      component: "daily_brief",
      event: "source_coverage",
      outcome: "missing",
      runId,
      data: { labels: missing.map((source) => source.safeLabel) },
    });
    return "daily_brief_source_coverage";
  }

  #findScheduled(localDate: string): ScheduledJobRow | undefined {
    return this.#db
      .prepare<{ subject_id: string }, ScheduledJobRow>(`
        SELECT id, trace_id, available_at_ms FROM jobs
        WHERE type = 'daily_brief' AND subject_id = @subject_id
      `)
      .get({ subject_id: localDate });
  }

  #runForJob(jobId: JobId): AgentRunRecord | undefined {
    const row = this.#db
      .prepare<{ scheduled_job_id: string }, { id: RunId }>(`
        SELECT id FROM agent_runs WHERE scheduled_job_id = @scheduled_job_id
      `)
      .get({ scheduled_job_id: jobId });
    return row === undefined ? undefined : this.#runs.getRequired(row.id);
  }

  #toolOutcomes(runId: RunId): readonly unknown[] {
    return this.#db
      .prepare<{ run_id: string }, { result_json: string | null }>(`
        SELECT result_json FROM tool_executions
        WHERE run_id = @run_id
        ORDER BY created_at_ms, id
      `)
      .all({ run_id: runId })
      .map((row) => (row.result_json === null ? null : (JSON.parse(row.result_json) as unknown)));
  }

  #localDateTime(epochMs: number): LocalDateTime {
    const values = new Map(
      this.#formatter
        .formatToParts(epochMs)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const required = (name: "year" | "month" | "day" | "hour" | "minute" | "second") => {
      const value = values.get(name);
      if (value === undefined || !Number.isInteger(value)) {
        throw new Error(`Unable to resolve ${name} in ${this.#config.dailyBrief.timeZone}`);
      }
      return value;
    };
    return {
      year: required("year"),
      month: required("month"),
      day: required("day"),
      hour: required("hour"),
      minute: required("minute"),
      second: required("second"),
    };
  }

  #epochForLocalHour(date: LocalDate, hour: number): number {
    const desiredAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0);
    let candidate = desiredAsUtc;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observed = this.#localDateTime(candidate);
      const observedAsUtc = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
      );
      const correction = desiredAsUtc - observedAsUtc;
      candidate += correction;
      if (correction === 0) {
        return candidate;
      }
    }
    const resolved = this.#localDateTime(candidate);
    if (
      resolved.year !== date.year ||
      resolved.month !== date.month ||
      resolved.day !== date.day ||
      resolved.hour !== hour ||
      resolved.minute !== 0 ||
      resolved.second !== 0
    ) {
      throw new Error(`Unable to resolve 08:00 in ${this.#config.dailyBrief.timeZone}`);
    }
    return candidate;
  }
}

function dailyBriefPayload(value: unknown): DailyBriefPayload {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("localDate" in value) ||
    typeof value.localDate !== "string" ||
    !localDatePattern.test(value.localDate) ||
    !("scheduledForMs" in value) ||
    typeof value.scheduledForMs !== "number" ||
    !Number.isSafeInteger(value.scheduledForMs) ||
    value.scheduledForMs < 0
  ) {
    throw new Error("Daily brief job payload is invalid");
  }
  return { localDate: value.localDate, scheduledForMs: value.scheduledForMs };
}

function dailyBriefSources(connections: readonly ConnectionRecord[]): readonly ConnectionRecord[] {
  return connections.filter(
    (connection) =>
      connection.status === "healthy" &&
      (connection.capabilities.includes("gmail.search") ||
        connection.capabilities.includes("notion.search")),
  );
}

function exactSearchLabel(toolName: string, argumentsJson: string): string | undefined {
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const field = toolName === "gmail.search" ? "account" : "workspace";
    const label = (value as Record<string, unknown>)[field];
    return typeof label === "string" ? label : undefined;
  } catch {
    return undefined;
  }
}

function dailyBriefRequest(
  payload: DailyBriefPayload,
  timeZone: string,
  sources: readonly ConnectionRecord[],
): string {
  const safeSources = sources.map((connection) => ({
    provider: connection.provider,
    label: connection.safeLabel,
    capabilities: connection.capabilities.filter(
      (capability) =>
        capability === "gmail.search" ||
        capability === "gmail.read_thread" ||
        capability === "notion.search" ||
        capability === "notion.fetch",
    ),
  }));
  return [
    `Prepare the scheduled morning brief for ${payload.localDate} in ${timeZone}.`,
    "This scheduled task is read-only and does not authorize any provider mutation.",
    `Healthy sources requiring one explicit search attempt each: ${JSON.stringify(safeSources)}.`,
    "For every Gmail source, call gmail.search with its exact account label and focus on important unread or new mail from the last day. Read a thread only when its metadata is insufficient.",
    "For every Notion source, call notion.search with its exact workspace label and focus on today's tasks, deadlines, and recently relevant work. Fetch only the results needed to understand them.",
    "Do not silently omit a listed source. If a search attempt fails, name its safe label and continue with the others.",
    "Return one concise iMessage with: priorities first, important email, Notion work, and a short source-status note. Do not invent events or calendar data.",
  ].join("\n");
}

function asLocalDate(value: LocalDateTime): LocalDate {
  return { year: value.year, month: value.month, day: value.day };
}

function nextLocalDate(date: LocalDate): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function formatLocalDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}
