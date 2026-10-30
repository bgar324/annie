// The inbound and scheduled-brief matrix: real DeepSeek decisions against synthetic Google, Notion,
// website tasks, and Sendblue. Measures pass rate, pass-through rate, and latency together, so a prompt
// or runtime change is judged on both at once.
//
//   pnpm smoke:inbound                          every case once
//   pnpm smoke:inbound list_today yes_after_offer
//   pnpm smoke:inbound --category google_read --repeat 3
//   pnpm smoke:inbound --category daily_brief
//   pnpm smoke:inbound --list | --keep
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";
import { z } from "zod";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import { newTraceId } from "../src/core/ids.js";
import type { InboundMessage, MessageGateway } from "../src/messages/types.js";
import { createRuntime, type AssistantRuntime } from "../src/runtime.js";
import { cases, type Category, type Observation, type SmokeCase } from "./smoke/cases.js";
import { line, seedDeliveredExchange, seedFailedHistory, syntheticGoogle, syntheticNotion, syntheticTodo, user } from "./smoke/synthetic.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--list")) {
  for (const smokeCase of cases) console.log(`${smokeCase.name.padEnd(28)} ${smokeCase.category}`);
  process.exit(0);
}
const keep = args.includes("--keep");
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const repeat = Number(flag("--repeat") ?? "1");
assert(Number.isInteger(repeat) && repeat >= 1, "--repeat needs a positive integer");
const category = flag("--category") as Category | undefined;
const names = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--repeat" && args[index - 1] !== "--category");
assert(names.every((name) => cases.some((smokeCase) => smokeCase.name === name)), "Unknown smoke case; use --list");
const selected = cases.filter((smokeCase) =>
  (names.length === 0 || names.includes(smokeCase.name)) && (category === undefined || smokeCase.category === category));
assert(selected.length > 0, "No case matches the selection");

const local = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const deepseek = Object.fromEntries([
  "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_REASONING_EFFORT",
].flatMap((key) => {
  const value = process.env[key] ?? local[key];
  return value === undefined ? [] : [[key, value]];
}));
const deepseekApiKey = z.string().min(1, "DEEPSEEK_API_KEY is required").parse(deepseek.DEEPSEEK_API_KEY);
const allowedOrigin = new URL(deepseek.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").origin;
const networkFetch = globalThis.fetch;

// Captured so the matrix can assert what the real model was offered and shown, and time
// every call to the byte, not to the headers.
const modelCallSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullish() })).min(1),
  response_format: z.object({ type: z.string() }).optional(),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional(),
  reasoning_effort: z.enum(["low", "medium", "high", "max"]),
});
type ModelCall = z.infer<typeof modelCallSchema> & { kind: "agent" | "memory"; durationMs: number; requestBytes: number };
let modelCalls: ModelCall[] = [];
let blockedRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== allowedOrigin) {
    blockedRequests += 1;
    throw new Error("Smoke network boundary refused non-DeepSeek request");
  }
  const requestBody = input instanceof Request && input.method === "POST"
    ? await input.clone().text()
    : undefined;
  const parsed = requestBody === undefined ? undefined : modelCallSchema.parse(JSON.parse(requestBody));
  const startedAt = Date.now();
  const response = await networkFetch(input, { ...init, redirect: "error" });
  const body = await response.text();
  if (parsed !== undefined) {
    const head = parsed.messages[0]?.content ?? "";
    modelCalls.push({ ...parsed, kind: head.startsWith("Maintain the canonical") ? "memory" : "agent", durationMs: Date.now() - startedAt, requestBytes: Buffer.byteLength(requestBody ?? "") });
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
await assert.rejects(fetch("https://sendblue.invalid/probe"), /Smoke network boundary/u);
assert.equal(blockedRequests, 1);
blockedRequests = 0;

async function drain(runtime: AssistantRuntime): Promise<void> {
  const controller = new AbortController();
  const worker = runtime.worker.run(controller.signal);
  const deadline = Date.now() + 240_000;
  try {
    while (runtime.database.db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'running')",
    ).get()?.count !== 0) {
      assert(Date.now() < deadline, "Queue did not settle within production run/memory budgets");
      await sleep(100);
    }
  } finally {
    controller.abort();
    await worker;
  }
}

async function runScheduledBrief(runtime: AssistantRuntime, config: RuntimeConfig): Promise<void> {
  // Use today's actual local date, including DST, but invoke the scheduler at 08:00.
  // The model and egress keep real wall time, so delivery retains its production expiry.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.dailyBrief.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const target = Date.parse(`${localDate}T08:00:00.000Z`);
  let morning = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = Object.fromEntries(formatter.formatToParts(new Date(morning)).map((part) => [part.type, part.value]));
    const represented = Date.parse(`${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}:${local.second}.000Z`);
    morning += target - represented;
  }
  const scheduled = runtime.dailyBrief.reconcile(morning);
  assert.equal(scheduled.kind, "scheduled", "The actual scheduler must create the daily job");
  assert(scheduled.kind === "scheduled");
  assert.equal(scheduled.localDate, localDate);
  assert.equal(scheduled.scheduledForMs, morning);
  const nowMs = morning + 1;
  const job = runtime.queue.claim(Math.max(Date.now(), nowMs));
  assert(job !== undefined && job.id === scheduled.jobId && job.type === "daily_brief");
  await runtime.handlers.daily_brief(job, {
    signal: new AbortController().signal,
    nowMs: () => nowMs,
    assertLease: () => runtime.queue.assertLease(job),
  });
  runtime.queue.complete(job);
  await drain(runtime);
}

interface CaseResult {
  name: string;
  category: Category;
  iteration: number;
  passed: boolean;
  passThrough: boolean;
  latencyMs: number;
  firstReplyMs: number;
  rounds: number;
  agentMs: number[];
  agentRequestBytes: number[];
  reasoningEfforts: string[];
  memoryReasoningEfforts: string[];
  tools: string[];
  reply: string;
  error?: string;
  artifacts?: string;
}

async function runCase(smokeCase: SmokeCase, iteration: number): Promise<CaseResult> {
  const directory = mkdtempSync(join(tmpdir(), "annie-smoke-"));
  const todoToken = randomBytes(32).toString("hex");
  const config = loadRuntimeConfig({
    NODE_ENV: "test", DATA_DIR: directory,
    PUBLIC_BASE_URL: "https://annie.invalid", SENDBLUE_BASE_URL: "https://sendblue.invalid",
    NOTION_MCP_URL: "https://notion.invalid/mcp",
    SENDBLUE_API_KEY_ID: "synthetic", SENDBLUE_API_SECRET_KEY: "synthetic-secret",
    SENDBLUE_FROM_NUMBER: line, USER_PHONE_NUMBER: user,
    GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic-secret",
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DAILY_BRIEF_ENABLED: String(smokeCase.dailyBrief === true), ...deepseek,
    ...(smokeCase.todoEnabled === true ? { TODO_API_URL: "https://todo.invalid", TODO_AGENT_TOKEN: todoToken } : {}),
  });
  writeFileSync(config.memoryPath, `# Memory\n\n- My todo list is Daily tasks in Personal.\n- Use UTC for dates.\n${smokeCase.memory ?? ""}`);
  const notion = syntheticNotion(smokeCase.notion);
  const google = syntheticGoogle(smokeCase.google);
  const todo = syntheticTodo(todoToken, smokeCase.todo);
  const inbox: InboundMessage[] = [];
  const sent: string[] = [];
  const sentAt: number[] = [];
  const gateway: MessageGateway = {
    async listInbound(input) {
      const matches = inbox.filter((message) => message.updatedAtMs >= input.updatedAtGteMs);
      return { messages: matches.slice(input.offset, input.offset + input.limit), total: matches.length };
    },
    async startTyping() { return undefined; },
    async send(input) {
      sent.push(input.text);
      sentAt.push(Date.now());
      return { messageHandle: `sent_${sent.length}`, status: "delivered", error: null };
    },
    async getStatus(handle) { return { messageHandle: handle, status: "delivered", error: null }; },
  };
  const overrides = {
    messageGateway: gateway, notionClients: notion.clients, logger: false as const,
    gmailClients: google.gmailClients, googleWorkspaceClients: google.googleWorkspaceClients,
    todoFetch: todo.fetch,
    weatherFetch: async (input: string | URL | Request) => {
      const url = new URL(new Request(input).url);
      assert(["api.weather.gov", "api.open-meteo.com", "geocoding-api.open-meteo.com"].includes(url.hostname));
      if (smokeCase.weatherAvailable === false) return new Response("", { status: 503 });
      if (url.hostname === "api.weather.gov") {
        if (url.pathname.startsWith("/points/")) {
          return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/LOX/148,47/forecast" } });
        }
        const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
        return Response.json({ properties: { periods: [
          { startTime: `${date}T06:00:00-07:00`, endTime: `${date}T18:00:00-07:00`, isDaytime: true, temperature: 78, temperatureUnit: "F", shortForecast: "Sunny" },
          { startTime: `${date}T18:00:00-07:00`, endTime: `${date}T23:59:59-07:00`, isDaytime: false, temperature: 61, temperatureUnit: "F", shortForecast: "Clear" },
        ] } });
      }
      if (url.hostname === "geocoding-api.open-meteo.com") {
        const city = url.searchParams.get("name")?.split(",")[0]?.trim().toLowerCase();
        const locations = [
          { name: "Tokyo", admin1: "Tokyo", country: "Japan", latitude: 35.6895, longitude: 139.69171 },
          { name: "West Covina", admin1: "California", country: "United States", latitude: 34.06862, longitude: -117.93895 },
        ];
        return Response.json({ results: locations.filter((location) => location.name.toLowerCase() === city) });
      }
      const longitude = Number(url.searchParams.get("longitude"));
      const tokyo = longitude === 139.69171;
      const covina = longitude === -117.93895;
      const timezone = tokyo ? "Asia/Tokyo" : "America/Los_Angeles";
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
      return Response.json({
        timezone,
        daily_units: { time: "iso8601", temperature_2m_max: "°F", temperature_2m_min: "°F", weather_code: "wmo code" },
        daily: {
          time: [date], temperature_2m_max: [tokyo ? 86 : covina ? 91 : 78],
          temperature_2m_min: [tokyo ? 70 : covina ? 66 : 61], weather_code: [0],
        },
      });
    },
  };
  let runtime = await createRuntime(config, overrides);
  const result: CaseResult = {
    name: smokeCase.name, category: smokeCase.category, iteration, passed: false, passThrough: false,
    latencyMs: 0, firstReplyMs: 0, rounds: 0, agentMs: [], agentRequestBytes: [], reasoningEfforts: [], memoryReasoningEfforts: [], tools: [], reply: "",
  };
  try {
    runtime.localUi.connections.saveAuthorization({
      traceId: newTraceId(), provider: "notion", providerAccountId: "synthetic-workspace",
      safeLabel: "Personal", safeMetadata: { workspaceName: "Personal" },
      providerState: { scopes: ["user", "workspace"] },
      capabilities: ["notion.search", "notion.fetch", "notion.create_page", "notion.update_page"],
      credentials: { accessToken: "synthetic-token" },
    });
    runtime.localUi.connections.saveAuthorization({
      traceId: newTraceId(), provider: "google", providerAccountId: "synthetic-google-sub",
      safeLabel: "ben@example.test", safeMetadata: { email: "ben@example.test" },
      providerState: { scopes: config.google.scopes },
      capabilities: ["gmail.read", "calendar.read", "drive.read", "contacts.read", "tasks.read"],
      credentials: { refreshToken: "synthetic-refresh" },
    });
    const seeded = smokeCase.history ?? [];
    seedFailedHistory(runtime.database.db, seeded);
    if (smokeCase.exchange !== undefined) seedDeliveredExchange(runtime.database.db, smokeCase.exchange);
    modelCalls = [];
    for (const [index, text] of smokeCase.texts.entries()) {
      const timestamp = Date.now() + 1_000 + index;
      inbox.push({
        id: `input_${smokeCase.name}_${index}`, senderNumber: user, contactNumber: user,
        lineNumber: line, recipientNumber: line, text, hasMedia: false,
        isOutbound: false, messageType: "message", groupId: null, service: "iMessage",
        status: "RECEIVED", sentAtMs: timestamp, updatedAtMs: timestamp, replyToId: null,
      });
    }
    const startedAt = Date.now();
    if (smokeCase.dailyBrief === true) {
      assert.equal(smokeCase.texts.length, 0, "Scheduled cases do not inject inbound messages");
      await runScheduledBrief(runtime, config);
    } else {
      await runtime.receiver.sweepOnce(new AbortController().signal);
      await drain(runtime);
    }
    if (smokeCase.restart === true) {
      await runtime.close();
      runtime = await createRuntime(config, overrides);
      await drain(runtime);
    }
    const db = runtime.database.db;
    const observation: Observation = {
      texts: smokeCase.texts,
      runs: db.prepare<[], { phase: string }>(`
        SELECT runs.phase FROM agent_runs AS runs
        LEFT JOIN inbound_messages AS inbound ON inbound.id = runs.inbound_id
        WHERE runs.id <> 'run_offer' ORDER BY runs.created_at_ms, inbound.sequence
      `).all(),
      replies: db.prepare<[], { purpose: string; state: string }>(
        "SELECT purpose, state FROM egress_messages WHERE id <> 'eg_offer' ORDER BY created_at_ms",
      ).all(),
      sent, notion, google, todo, config, runtime,
      offeredTools: modelCalls.filter((call) => call.kind === "agent")
        .map((call) => (call.tools ?? []).map((tool) => tool.function.name)),
      tools: db.prepare<[], { tool_name: string; status: string }>(
        "SELECT tool_name, status FROM tool_executions ORDER BY rowid",
      ).all(),
      writes: db.prepare<[], { state: string }>(
        "SELECT state FROM write_intents WHERE kind NOT LIKE 'sendblue_%'",
      ).all(),
    };
    result.latencyMs = (sentAt.at(-1) ?? startedAt) - startedAt;
    result.firstReplyMs = (sentAt[0] ?? startedAt) - startedAt;
    result.rounds = modelCalls.filter((call) => call.kind === "agent").length;
    result.agentMs = modelCalls.filter((call) => call.kind === "agent").map((call) => call.durationMs);
    result.agentRequestBytes = modelCalls.filter((call) => call.kind === "agent").map((call) => call.requestBytes);
    result.reasoningEfforts = modelCalls.filter((call) => call.kind === "agent").map((call) => call.reasoning_effort);
    result.memoryReasoningEfforts = modelCalls.filter((call) => call.kind === "memory").map((call) => call.reasoning_effort);
    result.tools = observation.tools.map((tool) => `${tool.tool_name}:${tool.status}`);
    result.reply = smokeCase.name === "connect_google"
      ? (sent.at(-1) ?? "").replace(/https:\/\/\S+/gu, "[synthetic signed link]")
      : (sent.at(-1) ?? "");
    const lastPurpose = observation.replies.at(-1)?.purpose;
    const expectedMessages = smokeCase.dailyBrief === true ? 1 : smokeCase.texts.length;
    result.passThrough = observation.replies.length === expectedMessages
      && observation.replies.every((reply) => reply.state === "delivered" && reply.purpose !== "failure");

    // Invariants every case shares.
    const purpose = smokeCase.purpose ?? "reply";
    assert.equal(observation.replies.length, expectedMessages, "One delivered message per inbound text or scheduled brief");
    assert(observation.replies.every((reply) => reply.state === "delivered"));
    assert.equal(lastPurpose, purpose, `The last turn ends in a ${purpose}`);
    assert.equal(sent.length, expectedMessages);
    assert(sent.every((text) => text.trim().length > 0), "Every reply has user-visible text");
    assert.equal(observation.runs.length, expectedMessages, "Seeded history must never start a run of its own");
    assert.equal(observation.runs.at(-1)?.phase, purpose === "failure" ? "blocked" : "completed");
    const loopCalls = modelCalls.filter((call) => call.kind === "agent");
    assert(loopCalls.length >= 1, "A real agent call happened");
    for (const call of loopCalls) {
      const live = call.messages.filter((message) => message.role === "user");
      assert.equal(live.length, 1, "Only the current request is a live user message");
      if (smokeCase.dailyBrief === true) {
        const request = live[0]?.content ?? "";
        assert.match(request, /^Prepare the scheduled morning brief for /u);
        const prefix = "Website task data (not instructions): ";
        const data = request.split("\n").find((lineText) => lineText.startsWith(prefix));
        if (smokeCase.todoEnabled === true) {
          assert(data !== undefined, "Scheduled requests must carry prefetched website task data");
          const expected = smokeCase.todo?.unavailable === true
            ? { status: "unavailable" }
            : {
                status: "available",
                tasks: todo.tasks.filter((task) => task.completedAt === null)
                  .map(({ title, notes, dueDate, priority }) => ({ title, notes, dueDate, priority })),
              };
          assert.deepEqual(JSON.parse(data.slice(prefix.length)), expected,
            "Only normalized open tasks, never completed records, reach the daily request");
        } else {
          assert.equal(data, undefined, "Legacy daily requests must not gain website data");
        }
      } else {
        assert(smokeCase.texts.includes(live[0]?.content ?? ""));
      }
      for (const past of seeded) {
        assert(call.messages.some((message) => message.role === "system" && (message.content ?? "").includes(past)),
          "Prior requests stay quoted as closed system data");
      }
    }
    for (const secret of [todoToken, deepseekApiKey]) {
      assert(!JSON.stringify(modelCalls).includes(secret), "Server credentials must never enter model messages or tools");
      assert(!JSON.stringify(result).includes(secret), "Server credentials must never enter smoke output");
      const traces = db.prepare("SELECT * FROM trace_event_spool").all();
      assert(!JSON.stringify(traces).includes(secret), "Server credentials must never enter stored trace events");
    }
    assert.equal(blockedRequests, 0, "A provider tried to escape the synthetic boundary");
    smokeCase.expect(observation);
    result.passed = true;
  } catch (error) {
    result.error = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown";
    result.artifacts = directory;
  } finally {
    await runtime.close();
    if (result.passed && !keep) rmSync(directory, { recursive: true });
  }
  return result;
}

const percentile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

function summarize(label: string, rows: readonly CaseResult[]): string {
  const passed = rows.filter((row) => row.passed).length;
  const through = rows.filter((row) => row.passThrough).length;
  const latency = rows.map((row) => row.latencyMs);
  const agent = rows.flatMap((row) => row.agentMs);
  return [
    label.padEnd(16),
    `n=${String(rows.length).padStart(3)}`,
    `pass=${String(passed).padStart(3)}`,
    `through=${String(through).padStart(3)}`,
    `latency p50=${String(percentile(latency, 0.5)).padStart(6)}ms p95=${String(percentile(latency, 0.95)).padStart(6)}ms`,
    `rounds p50=${percentile(rows.map((row) => row.rounds), 0.5)}`,
    `agent call p50=${percentile(agent, 0.5)}ms p95=${percentile(agent, 0.95)}ms`,
  ].join("  ");
}

const results: CaseResult[] = [];
try {
  for (let iteration = 1; iteration <= repeat; iteration += 1) {
    for (const smokeCase of selected) {
      const result = await runCase(smokeCase, iteration);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
} finally {
  globalThis.fetch = networkFetch;
}

console.log("");
for (const group of [...new Set(results.map((row) => row.category))]) {
  console.log(summarize(group, results.filter((row) => row.category === group)));
}
console.log(summarize("ALL", results));
const failed = results.filter((row) => !row.passed);
for (const row of failed) console.log(`FAILED ${row.name} #${row.iteration}: ${row.error}  (${row.artifacts})`);
process.exitCode = failed.length === 0 ? 0 : 1;
