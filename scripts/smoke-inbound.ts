// Real DeepSeek decisions; synthetic accounts, Notion state, and Sendblue only.
// pnpm smoke:inbound [case names] [--keep] | pnpm smoke:inbound --list
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
import type { NotionClientProvider } from "../src/notion/client.js";
import { createRuntime, type AssistantRuntime } from "../src/runtime.js";

const requests = {
  relative_date_checkbox: "Could you mark yesterday's clean and organize room done?",
  already_checked_no_op: "Could you mark yesterday's clean and organize room done?",
  add_task: "Add to my todo list - clean up google storage and iCloud storage",
  read_failure: "Can you mark clean restroom done on today's list?",
  ambiguous_write: "Can you mark clean restroom done on today's list?",
  connect_google: "connect google",
};
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--list")) {
  console.log(Object.keys(requests).join("\n"));
  process.exit(0);
}
const keep = args.includes("--keep");
const names = args.filter((arg) => arg !== "--keep");
assert(names.every((name) => Object.hasOwn(requests, name)), "Unknown smoke case; use --list");
const cases = Object.entries(requests).filter(([name]) => names.length === 0 || names.includes(name));
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
let blockedRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== allowedOrigin) {
    blockedRequests += 1;
    throw new Error("Smoke network boundary refused non-DeepSeek request");
  }
  return networkFetch(input, { ...init, redirect: "error" });
};
await assert.rejects(fetch("https://sendblue.invalid/probe"), /Smoke network boundary/u);
assert.equal(blockedRequests, 1);
blockedRequests = 0;

const line = "+15550000001";
const user = "+15550000002";
const patchSchema = z.object({
  page_id: z.string(),
  command: z.literal("update_content"),
  content_updates: z.tuple([z.object({
    old_str: z.string().min(1),
    new_str: z.string(),
    replace_all_matches: z.literal(false),
  })]),
});

async function drain(runtime: AssistantRuntime): Promise<void> {
  const controller = new AbortController();
  const worker = runtime.worker.run(controller.signal);
  const deadline = Date.now() + 180_000;
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

async function runCase(name: string, text: string): Promise<void> {
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
  const date = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const yesterday = `## ${date(-1)}\n- [${name === "already_checked_no_op" ? "x" : " "}] Clean and organize room\n- [x] Wash car`;
  const today = `## ${date(0)}\n- [ ] Clean restroom\n- [ ] Water plants\n- [ ] Clean and organize room`;
  const original = `# Daily tasks\n\n## ${date(-2)}\n- [ ] Clean and organize room\n\n${yesterday}\n\n${today}\n`;
  const pages = new Map([
    ["daily", original],
    ["archive", "# Task archive\n- [ ] Clean restroom\n- [ ] Clean and organize room\n"],
  ]);
  let mutations = 0;
  const notion: NotionClientProvider = {
    async withSession(_connection, _trace, operation) {
      return operation({
        validate(tool, argumentsValue) {
          if (tool === "notion-update-page") patchSchema.parse(argumentsValue);
        },
        async call(tool, argumentsValue) {
          if (tool === "notion-search") {
            return { structuredContent: { truncated: false, results: [
              { id: "daily", title: "Daily tasks" }, { id: "archive", title: "Task archive" },
            ] } };
          }
          if (tool === "notion-fetch") {
            if (name === "read_failure") throw new Error("Synthetic Notion read unavailable");
            const { id } = z.object({ id: z.string() }).parse(argumentsValue);
            assert(pages.has(id), "Model fetched an unknown synthetic page");
            return { structuredContent: { id, text: pages.get(id), truncated: false } };
          }
          assert.equal(tool, "notion-update-page", "Expected an update, not page creation");
          const patch = patchSchema.parse(argumentsValue);
          const source = pages.get(patch.page_id);
          assert(source !== undefined, "Model wrote an unknown page");
          const [change] = patch.content_updates;
          const offset = source.indexOf(change.old_str);
          assert(offset >= 0 && source.indexOf(change.old_str, offset + 1) === -1, "Provider source must be unique");
          mutations += 1;
          pages.set(patch.page_id, source.replace(change.old_str, change.new_str));
          if (name === "ambiguous_write") throw new Error("Synthetic response lost after acceptance");
          return { structuredContent: { id: patch.page_id, truncated: false } };
        },
      });
    },
  };
  const inbox: InboundMessage[] = [];
  const sent: string[] = [];
  const gateway: MessageGateway = {
    async listInbound(input) {
      const matches = inbox.filter((message) => message.updatedAtMs >= input.updatedAtGteMs);
      return { messages: matches.slice(input.offset, input.offset + input.limit), total: matches.length };
    },
    async openInboundWakeStream() { throw new Error("Smoke never opens the event stream"); },
    async send(input) {
      sent.push(input.text);
      return { messageHandle: `sent_${sent.length}`, status: "delivered", error: null };
    },
    async getStatus(handle) { return { messageHandle: handle, status: "delivered", error: null }; },
  };
  const overrides = {
    messageGateway: gateway, notionClients: notion, logger: false as const,
    gmailClients: { async forConnection() { throw new Error("Google is offline in this smoke"); } },
    googleWorkspaceClients: { async forConnection() { throw new Error("Google is offline in this smoke"); } },
  };
  let runtime = await createRuntime(config, overrides);
  let passed = false;
  try {
    runtime.localUi.connections.saveAuthorization({
      traceId: newTraceId(), provider: "notion", providerAccountId: "synthetic-workspace",
      safeLabel: "Personal", safeMetadata: { workspaceName: "Personal" },
      providerState: { scopes: ["user", "workspace"] },
      capabilities: ["notion.search", "notion.fetch", "notion.create_page", "notion.update_page"],
      credentials: { accessToken: "synthetic-token" },
    });
    const timestamp = Date.now() + 1_000;
    inbox.push({
      id: `input_${name}`, senderNumber: user, contactNumber: user,
      lineNumber: line, recipientNumber: line, text, hasMedia: false,
      isOutbound: false, messageType: "message", groupId: null, service: "iMessage",
      status: "RECEIVED", sentAtMs: timestamp, updatedAtMs: timestamp, replyToId: null,
    });
    await runtime.receiver.sweepOnce(new AbortController().signal);
    await drain(runtime);
    if (name === "ambiguous_write" || name === "connect_google") {
      await runtime.close();
      runtime = await createRuntime(config, overrides);
      await drain(runtime);
    }
    const db = runtime.database.db;
    const tools = db.prepare<[], { tool_name: string; status: string }>(
      "SELECT tool_name, status FROM tool_executions ORDER BY rowid",
    ).all();
    const writes = db.prepare<[], { state: string }>(
      "SELECT state FROM write_intents WHERE kind <> 'sendblue_send_message'",
    ).all();
    const reply = db.prepare<[], { purpose: string; state: string }>(
      "SELECT purpose, state FROM egress_messages",
    ).all();
    const run = db.prepare<[], { phase: string }>("SELECT phase FROM agent_runs").get();
    const purpose = name === "ambiguous_write" ? "failure" : name === "connect_google" ? "recovery" : "reply";
    assert.deepEqual(reply, [{ purpose, state: "delivered" }]);
    assert.equal(sent.length, 1);
    assert(sent[0]?.trim(), "Expected a user-visible reply");
    assert.equal(run?.phase, name === "ambiguous_write" ? "blocked" : "completed");
    assert.equal(pages.get("archive"), "# Task archive\n- [ ] Clean restroom\n- [ ] Clean and organize room\n");
    if (name === "connect_google") {
      assert.equal(mutations, 0);
      assert.deepEqual(writes, []);
      assert.deepEqual(tools, [{ tool_name: "connections.connect", status: "succeeded" }]);
      assert.equal(pages.get("daily"), original);
      const url = new URL(sent[0]?.split("\n").at(-1) ?? "");
      assert.equal(url.origin, new URL(config.publicBaseUrl).origin);
      assert.equal(url.pathname, "/connect/google");
      const token = url.searchParams.get("token");
      assert(token);
      assert.equal(runtime.localUi.links.resolve(token, "google").provider, "google");
    } else if (name === "already_checked_no_op" || name === "read_failure") {
      assert.equal(mutations, 0);
      assert.deepEqual(writes, []);
      assert.equal(pages.get("daily"), original);
      assert(tools.some((tool) => tool.tool_name === "notion.fetch" && tool.status === (name === "read_failure" ? "failed" : "succeeded")));
    } else {
      assert.equal(mutations, 1, "Exactly one provider mutation, including after restart");
      assert.deepEqual(writes, [{ state: name === "ambiguous_write" ? "ambiguous" : "succeeded" }]);
      if (name === "relative_date_checkbox") {
        assert.equal(pages.get("daily"), original.replace(yesterday, yesterday.replace("[ ]", "[x]")));
      } else if (name === "ambiguous_write") {
        assert.equal(pages.get("daily"), original.replace("[ ] Clean restroom", "[x] Clean restroom"));
      } else {
        const changed = pages.get("daily") ?? "";
        const before = original.trimEnd().split("\n");
        const added: string[] = [];
        let cursor = 0;
        for (const lineText of changed.trimEnd().split("\n")) {
          if (lineText === before[cursor]) cursor += 1;
          else added.push(lineText);
        }
        assert.equal(cursor, before.length, "Task addition must preserve every original line");
        assert(added.length >= 1 && added.length <= 2 && added.every((item) => /^- \[ \] /u.test(item)));
        assert(/google storage/iu.test(added.join(" ")) && /icloud storage/iu.test(added.join(" ")));
        assert(changed.startsWith(original.slice(0, original.indexOf(today))), "Earlier days must be unchanged");
      }
    }
    assert.equal(blockedRequests, 0, "A provider tried to escape the synthetic boundary");
    const displayReply = name === "connect_google"
      ? sent[0]?.replace(/https:\/\/\S+/gu, "[synthetic signed link]")
      : sent[0];
    console.log(JSON.stringify({ case: name, mutations, tools, reply: displayReply, passed: true }));
    passed = true;
  } finally {
    await runtime.close();
    if (passed && !keep) rmSync(directory, { recursive: true });
    else console.log(`Synthetic artifacts: ${directory}`);
  }
}

try {
  for (const [name, request] of cases) await runCase(name, request);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replaceAll(deepseek.DEEPSEEK_API_KEY, "[redacted]"));
  process.exitCode = 1;
} finally {
  globalThis.fetch = networkFetch;
}
