// The inbound request matrix: real DeepSeek decisions against synthetic Google, Notion,
// and Sendblue. Measures pass rate, pass-through rate, and latency together, so a prompt
// or runtime change is judged on both at once.
//
//   pnpm smoke:inbound                          every case once
//   pnpm smoke:inbound list_today yes_after_offer
//   pnpm smoke:inbound --category google_read --repeat 3
//   pnpm smoke:inbound --list | --keep
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";
import { z } from "zod";
import { loadRuntimeConfig } from "../src/config.js";
import { newTraceId } from "../src/core/ids.js";
import type { InboundMessage, MessageGateway } from "../src/messages/types.js";
import { createRuntime, type AssistantRuntime } from "../src/runtime.js";
import { cases, type Category, type Observation, type SmokeCase } from "./smoke/cases.js";
import { line, seedDeliveredExchange, seedFailedHistory, syntheticGoogle, syntheticNotion, user } from "./smoke/synthetic.js";

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
assert(deepseek.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY is required");
const allowedOrigin = new URL(deepseek.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").origin;
const networkFetch = globalThis.fetch;

// Captured so the matrix can assert what the real model was offered and shown, and time
// every call to the byte, not to the headers.
const modelCallSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullish() })).min(1),
  response_format: z.object({ type: z.string() }).optional(),
  tools: z.array(z.unknown()).optional(),
});
const responseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({ content: z.string().nullish() }).loose(),
  }).loose()).min(1),
}).loose();
type ModelCall = z.infer<typeof modelCallSchema> & {
  kind: "classifier" | "agent" | "memory";
  durationMs: number;
  finishReason: string | null;
  verdict: string | null;
};
let modelCalls: ModelCall[] = [];
let blockedRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== allowedOrigin) {
    blockedRequests += 1;
    throw new Error("Smoke network boundary refused non-DeepSeek request");
  }
  const parsed = input instanceof Request && input.method === "POST"
    ? modelCallSchema.parse(JSON.parse(await input.clone().text()))
    : undefined;
  const startedAt = Date.now();
  const response = await networkFetch(input, { ...init, redirect: "error" });
  const body = await response.text();
  if (parsed !== undefined) {
    const head = parsed.messages[0]?.content ?? "";
    const kind = head.startsWith("You are Annie") ? "agent" : head.startsWith("Maintain the canonical") ? "memory" : "classifier";
    const choice = response.ok ? responseSchema.safeParse(JSON.parse(body)) : undefined;
    const first = choice?.success === true ? choice.data.choices[0] : undefined;
    modelCalls.push({
      ...parsed, kind, durationMs: Date.now() - startedAt,
      finishReason: first?.finish_reason ?? null,
      verdict: kind === "classifier" ? (first?.message.content ?? null) : null,
    });
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

interface CaseResult {
  name: string;
  category: Category;
  iteration: number;
  passed: boolean;
  passThrough: boolean;
  latencyMs: number;
  firstReplyMs: number;
  rounds: number;
  classifierMs: number[];
  agentMs: number[];
  tools: string[];
  scopes: (string | null)[];
  /** Raw classifier output and finish reason, so a scope miss is diagnosable after eviction. */
  verdicts: string[];
  reply: string;
  error?: string;
  artifacts?: string;
}

async function runCase(smokeCase: SmokeCase, iteration: number): Promise<CaseResult> {
  const directory = mkdtempSync(join(tmpdir(), "annie-smoke-"));
  const config = loadRuntimeConfig({
    NODE_ENV: "test", DATA_DIR: directory,
    PUBLIC_BASE_URL: "https://annie.invalid", SENDBLUE_BASE_URL: "https://sendblue.invalid",
    NOTION_MCP_URL: "https://notion.invalid/mcp",
    SENDBLUE_API_KEY_ID: "synthetic", SENDBLUE_API_SECRET_KEY: "synthetic-secret",
    SENDBLUE_FROM_NUMBER: line, USER_PHONE_NUMBER: user,
    GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic-secret",
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DAILY_BRIEF_ENABLED: "false", ...deepseek,
  });
  writeFileSync(config.memoryPath, "# Memory\n\n- My todo list is Daily tasks in Personal.\n- Use UTC for dates.\n");
  const notion = syntheticNotion(smokeCase.notion);
  const google = syntheticGoogle(smokeCase.google);
  const inbox: InboundMessage[] = [];
  const sent: string[] = [];
  const sentAt: number[] = [];
  const gateway: MessageGateway = {
    async listInbound(input) {
      const matches = inbox.filter((message) => message.updatedAtMs >= input.updatedAtGteMs);
      return { messages: matches.slice(input.offset, input.offset + input.limit), total: matches.length };
    },
    async openInboundWakeStream() { throw new Error("Smoke never opens the event stream"); },
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
  };
  let runtime = await createRuntime(config, overrides);
  const result: CaseResult = {
    name: smokeCase.name, category: smokeCase.category, iteration, passed: false, passThrough: false,
    latencyMs: 0, firstReplyMs: 0, rounds: 0, classifierMs: [], agentMs: [], tools: [], scopes: [], verdicts: [], reply: "",
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
    await runtime.receiver.sweepOnce(new AbortController().signal);
    await drain(runtime);
    if (smokeCase.restart === true) {
      await runtime.close();
      runtime = await createRuntime(config, overrides);
      await drain(runtime);
    }
    const db = runtime.database.db;
    const observation: Observation = {
      texts: smokeCase.texts,
      runs: db.prepare<[], { phase: string; request_scope: string | null }>(`
        SELECT runs.phase, runs.request_scope FROM agent_runs AS runs
        JOIN inbound_messages AS inbound ON inbound.id = runs.inbound_id
        WHERE runs.id <> 'run_offer' ORDER BY inbound.sequence
      `).all(),
      replies: db.prepare<[], { purpose: string; state: string }>(
        "SELECT purpose, state FROM egress_messages WHERE id <> 'eg_offer' ORDER BY created_at_ms",
      ).all(),
      sent, notion, google, config, runtime,
      tools: db.prepare<[], { tool_name: string; status: string }>(
        "SELECT tool_name, status FROM tool_executions ORDER BY rowid",
      ).all(),
      writes: db.prepare<[], { state: string }>(
        "SELECT state FROM write_intents WHERE kind <> 'sendblue_send_message'",
      ).all(),
    };
    result.latencyMs = (sentAt.at(-1) ?? startedAt) - startedAt;
    result.firstReplyMs = (sentAt[0] ?? startedAt) - startedAt;
    result.rounds = modelCalls.filter((call) => call.kind === "agent").length;
    result.classifierMs = modelCalls.filter((call) => call.kind === "classifier").map((call) => call.durationMs);
    result.agentMs = modelCalls.filter((call) => call.kind === "agent").map((call) => call.durationMs);
    result.tools = observation.tools.map((tool) => `${tool.tool_name}:${tool.status}`);
    result.scopes = observation.runs.map((run) => run.request_scope);
    result.verdicts = modelCalls.filter((call) => call.kind === "classifier")
      .map((call) => `${call.finishReason ?? "?"}:${(call.verdict ?? "").replace(/\s+/gu, " ").slice(0, 60)}`);
    result.reply = smokeCase.name === "connect_google"
      ? (sent.at(-1) ?? "").replace(/https:\/\/\S+/gu, "[synthetic signed link]")
      : (sent.at(-1) ?? "");
    const lastPurpose = observation.replies.at(-1)?.purpose;
    result.passThrough = observation.replies.length === smokeCase.texts.length
      && observation.replies.every((reply) => reply.state === "delivered" && reply.purpose !== "failure");

    // Invariants every case shares.
    const purpose = smokeCase.purpose ?? "reply";
    assert.equal(observation.replies.length, smokeCase.texts.length, "One delivered message per inbound text");
    assert(observation.replies.every((reply) => reply.state === "delivered"));
    assert.equal(lastPurpose, purpose, `The last turn ends in a ${purpose}`);
    assert.equal(sent.length, smokeCase.texts.length);
    assert(sent.every((text) => text.trim().length > 0), "Every reply has user-visible text");
    assert.equal(observation.runs.length, smokeCase.texts.length, "Seeded history must never start a run of its own");
    assert.equal(observation.runs.at(-1)?.phase, purpose === "failure" ? "blocked" : "completed");
    for (const [index, expected] of smokeCase.scopes.entries()) {
      if (expected !== null) assert.equal(observation.runs[index]?.request_scope, expected, `Classification of text ${index + 1}`);
    }
    const scopeCalls = modelCalls.filter((call) => call.kind === "classifier");
    const loopCalls = modelCalls.filter((call) => call.kind === "agent");
    assert(scopeCalls.length >= smokeCase.texts.length && loopCalls.length >= 1, "Real scope and agent calls happened");
    for (const call of scopeCalls) {
      assert.equal(call.response_format?.type, "json_object");
      assert.equal(call.tools, undefined, "The classifier is offered no tools");
      assert.equal(call.messages.length, 2, "Classifier sees one policy plus the raw request");
      assert(smokeCase.texts.includes(call.messages[1]?.content ?? ""), "The classifier sees the raw request");
      for (const past of seeded) {
        assert(!call.messages.some((message) => (message.content ?? "").includes(past)), "History must never reach the classifier");
      }
      if (smokeCase.exchange !== undefined) {
        const policy = call.messages[0]?.content ?? "";
        assert(!policy.includes(smokeCase.exchange.question), "The user's earlier message never reaches the classifier");
        const fresh = smokeCase.exchange.state === "delivered" && smokeCase.exchange.ageMs < 30 * 60_000;
        assert.equal(policy.includes(smokeCase.exchange.reply), fresh, "Only a fresh delivered reply reaches the classifier");
      }
    }
    for (const call of loopCalls) {
      const live = call.messages.filter((message) => message.role === "user");
      assert.equal(live.length, 1, "Only the current inbound is a live user message");
      assert(smokeCase.texts.includes(live[0]?.content ?? ""));
      for (const past of seeded) {
        assert(call.messages.some((message) => message.role === "system" && (message.content ?? "").includes(past)),
          "Prior requests stay quoted as closed system data");
      }
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
    `classifier p50=${percentile(rows.flatMap((row) => row.classifierMs), 0.5)}ms`,
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
