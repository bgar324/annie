import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRunStore } from "../src/agent/store.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { ConnectionStore } from "../src/connections/store.js";
import { newTraceId } from "../src/core/ids.js";
import { runMigrations } from "../src/db/migrations.js";
import { parseCalendarEvents } from "../src/google/normalize.js";
import { CredentialVault } from "../src/security/vault.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { loadWebBriefConfig } from "../src/web-brief/config.js";
import { registerWebBriefRoutes } from "../src/web-brief/routes.js";
import { projectPreviewCalendar } from "../src/web-brief/preview.js";
import { codexAuthSchema, webBriefToolNames } from "../src/web-brief/schema.js";
import { WebBriefService } from "../src/web-brief/service.js";
import { WebBriefStore } from "../src/web-brief/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const databases: TestDatabase[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.cleanup();
});
const auth = codexAuthSchema.parse({ auth_mode: "chatgpt", tokens: {
  id_token: "synthetic-id", access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: "synthetic-account",
  oauth_provenance: { issuer: "https://auth.openai.com", client_id: "synthetic-client" }, login_owner_id: "synthetic-owner",
} });
const claimResult = z.object({ kind: z.literal("claimed"), date: z.string(), leaseToken: z.string(), credentialGeneration: z.number(),
  context: z.object({ window: z.object({ calendarStart: z.string(), calendarEnd: z.string(), modifiedAfter: z.string() }) }),
});

interface WebBriefHarness {
  db: Database.Database;
  vault: CredentialVault;
  service: WebBriefService;
  calls: string[];
  released: string[];
  store: WebBriefStore;
}

function harness(products: "gmail" | "all" = "gmail", result: unknown = { messages: [], truncated: false }): WebBriefHarness {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T14:00:00Z"));
  const database = createTestDatabase();
  databases.push(database);
  const db = database.handle.db;
  const vault = new CredentialVault(Buffer.alloc(32, 19));
  const traces = new TraceStore(db, createTraceRedactor([]));
  const runs = new AgentRunStore(db, traces);
  const connections = new ConnectionStore(db, vault, traces);
  connections.saveAuthorization({ traceId: newTraceId(), provider: "google", providerAccountId: "private-id-never-model",
    safeLabel: "Work", safeMetadata: { secretMetadata: "never-model" }, providerState: {},
    capabilities: products === "all" ? ["gmail.read", "calendar.read", "drive.read", "tasks.read", "contacts.read"] : ["gmail.read"], credentials: { refreshToken: "provider-token-never-model" },
  });
  const calls: string[] = [];
  const tools = new ToolRegistry(webBriefToolNames.map((name) => ({
    definition: { name, description: "Synthetic read adapter", parameters: { type: "object", additionalProperties: true } }, operationClass: "read" as const,
    execute: async () => { calls.push(name); return result; },
  })));
  const released: string[] = [];
  const service = new WebBriefService({ db, vault, traces, runs, connections, tools,
    loadContext: async () => ({ memory: "canonical user preferences", weather: { unavailable: true } }),
    releaseRun: (id) => { released.push(id); },
  });
  return { db, vault, service, calls, released, store: new WebBriefStore(db, vault) };
}
async function claimed(h: WebBriefHarness, requestId = "request-one") {
  await h.service.bootstrap(auth);
  return claimResult.parse(await h.service.claim(requestId));
}
function brief(date: string, sourceId: string) {
  return { date, title: "Morning", summary: "No urgent mail.", sections: [{ title: "Inbox", items: [{ text: "No urgent mail found.", sourceIds: [sourceId] }] }] };
}
async function mail(h: WebBriefHarness, leaseToken: string) {
  return h.service.tool({ leaseToken, callId: "mail-one", name: "gmail.search", arguments: { account: "Work", query: "newer_than:1d is:unread" } });
}

describe("private web brief lease and publication", () => {
  it("honors a heartbeat renewal for an in-flight read without extending the hard deadline", async () => {
    const h = harness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T14:00:00Z"));
    const claim = await claimed(h);
    const firstResult = Promise.withResolvers<unknown>();
    let signal: AbortSignal | undefined;
    const execute = vi.spyOn(h.service.input.tools, "execute").mockImplementation(async (input) => {
      signal = input.context.signal;
      return firstResult.promise;
    });
    const pending = mail(h, claim.leaseToken);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    h.service.heartbeat(claim.leaseToken);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(signal?.aborted).toBe(false);
    firstResult.resolve({ messages: [], messagesTruncated: false });
    expect((await pending).sourceId).not.toBeNull();
    const finalResult = Promise.withResolvers<unknown>();
    execute.mockImplementation(async (input) => {
      signal = input.context.signal;
      return finalResult.promise;
    });
    const late = h.service.tool({ leaseToken: claim.leaseToken, callId: "late-mail", name: "gmail.search", arguments: { account: "Work", query: "newer_than:1d" } });
    const observed = late.catch((error: unknown) => error);
    h.service.heartbeat(claim.leaseToken);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(signal?.aborted).toBe(true);
    finalResult.resolve({ messages: [] });
    expect(await observed).toMatchObject({ code: "stale_lease" });
  });

  it("publishes a paginated Gmail search only with visibly incomplete coverage", async () => {
    const h = harness("gmail", { messages: [{ id: "first" }], messagesTruncated: true });
    const claim = await claimed(h);
    const source = await mail(h, claim.leaseToken);
    expect(await h.service.complete({ ...claim, auth, brief: brief(claim.date, source.sourceId ?? "foreign"), errorCode: null }))
      .toMatchObject({ kind: "published" });
    expect(h.service.edition().edition?.coverage).toEqual([{ account: "Work", product: "gmail", status: "truncated" }]);
  });

  it("checks out encrypted auth once, exposes only safe context and requires reauth after a crash", async () => {
    const h = harness();
    const claim = await claimed(h);
    const raw = JSON.stringify(await h.service.claim("second-request"));
    expect(raw).toContain("busy");
    expect(JSON.stringify(claim)).not.toContain("private-id-never-model");
    const stored = h.db.prepare<[], { ciphertext: Buffer }>("SELECT ciphertext FROM web_brief_auth").get();
    expect(stored?.ciphertext.toString()).not.toContain("synthetic-refresh");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await h.service.claim("after-crash")).toMatchObject({ kind: "reauth_required" });
    expect(h.released).toHaveLength(1);
    expect(h.store.auth()?.state).toBe("reauth_required");
  });

  it("fences stale tool calls, heartbeat, attempts and auth/publication", async () => {
    const h = harness();
    const claim = await claimed(h);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(mail(h, claim.leaseToken)).rejects.toMatchObject({ code: "stale_lease" });
    expect(() => h.service.heartbeat(claim.leaseToken)).toThrow("stale_lease");
    expect(() => h.service.attempt({ leaseToken: claim.leaseToken, attemptId: "attempt-one", operation: "refresh" })).toThrow("stale_lease");
    await expect(h.service.complete({ ...claim, auth, brief: null, errorCode: "runner_failed" })).rejects.toMatchObject({ code: "stale_lease" });
    expect(h.calls).toEqual([]);
    expect(h.store.auth()?.generation).toBe(1);
    expect(h.service.edition().edition).toBeNull();
  });

  it("checkpoints renewed auth before rejecting malformed output", async () => {
    const h = harness();
    const claim = await claimed(h);
    const renewed = { ...auth, tokens: { ...auth.tokens, refresh_token: "rotated-synthetic" } };
    expect(await h.service.complete({ ...claim, auth: renewed, brief: { malformed: true }, errorCode: null })).toMatchObject({ kind: "failed", errorCode: "invalid_brief" });
    const saved = h.store.auth();
    expect(saved?.generation).toBe(2);
    expect(saved === undefined ? null : h.store.openAuth(saved).tokens.refresh_token).toBe("rotated-synthetic");
    expect(h.service.edition().edition).toBeNull();
  });

  it.each(["wrong_date", "foreign_citation", "missing_coverage"])("rejects %s after auth checkpoint", async (failure) => {
    const h = harness();
    const claim = await claimed(h);
    const source = failure === "missing_coverage"
      ? await h.service.tool({ leaseToken: claim.leaseToken, callId: "thread-only", name: "gmail.read_thread", arguments: { account: "Work", threadId: "thread-one" } })
      : await mail(h, claim.leaseToken);
    expect(source.sourceId).not.toBeNull();
    const output = brief(failure === "wrong_date" ? "2026-10-27" : claim.date, failure === "foreign_citation" ? "foreign" : source.sourceId ?? "foreign");
    const result = await h.service.complete({ ...claim, auth, brief: output, errorCode: null });
    expect(result).toMatchObject({ kind: "failed" });
    expect(h.store.auth()?.state).toBe("ready");
    expect(h.service.edition().edition).toBeNull();
  });

  it("requires the existing calendar, Drive and Tasks windows for every account facet", async () => {
    const h = harness("all", { results: [{ product: "calendar", ok: true }, { product: "drive", ok: true }, { product: "tasks", ok: true }] });
    const claim = await claimed(h);
    await mail(h, claim.leaseToken);
    const source = await h.service.tool({ leaseToken: claim.leaseToken, callId: "google-one", name: "google.search", arguments: { account: "Work", queries: [
      { product: "calendar", timeMin: claim.context.window.calendarStart, timeMax: claim.context.window.calendarEnd, maxResults: 20 },
      { product: "drive", modifiedAfter: "2020-01-01T00:00:00Z", maxResults: 20 },
      { product: "tasks", dueBefore: claim.context.window.calendarEnd, includeCompleted: false, maxResults: 20 },
    ] } });
    expect(await h.service.complete({ ...claim, auth, brief: brief(claim.date, source.sourceId ?? "foreign"), errorCode: null }))
      .toMatchObject({ kind: "failed", errorCode: "source_coverage_missing" });
  });

  it("retains every Google product with honest partial coverage and exact morning windows", async () => {
    const h = harness("all", { results: [
      { product: "calendar", ok: true, incomplete: true },
      { product: "drive", ok: false, error: { code: "unavailable" } },
      { product: "tasks", ok: true, truncated: false },
    ] });
    const claim = await claimed(h);
    expect(claim.context.window).toEqual({ calendarStart: "2026-10-28T15:00:00.000Z", calendarEnd: "2026-10-29T15:00:00.000Z", modifiedAfter: "2026-10-27T15:00:00.000Z" });
    await mail(h, claim.leaseToken);
    const source = await h.service.tool({ leaseToken: claim.leaseToken, callId: "google-all", name: "google.search", arguments: { account: "Work", queries: [
      { product: "calendar", timeMin: claim.context.window.calendarStart, timeMax: claim.context.window.calendarEnd, maxResults: 20 },
      { product: "drive", modifiedAfter: claim.context.window.modifiedAfter, maxResults: 20 },
      { product: "tasks", dueBefore: claim.context.window.calendarEnd, includeCompleted: false, maxResults: 20 },
    ] } });
    expect(await h.service.complete({ ...claim, auth, brief: brief(claim.date, source.sourceId ?? "foreign"), errorCode: null })).toMatchObject({ kind: "published" });
    expect(h.service.edition().edition?.coverage).toEqual(expect.arrayContaining([
      { account: "Work", product: "calendar", status: "truncated" },
      { account: "Work", product: "drive", status: "unavailable" },
      { account: "Work", product: "tasks", status: "complete" },
    ]));
  });

  it("returns an explicit incomplete marker instead of oversized source text", async () => {
    const h = harness("gmail", { messages: [{ text: "x".repeat(150_000) }] });
    const claim = await claimed(h);
    const source = await mail(h, claim.leaseToken);
    expect(source.value).toMatchObject({ truncated: true, incomplete: true, error: { code: "source_budget_exceeded" } });
    expect(Buffer.byteLength(JSON.stringify(source.value))).toBeLessThan(131_072);
  });

  it("publishes exact completion once, strips provenance and bounds retained context", async () => {
    const h = harness("gmail", { messages: [], hidden: { pages: [{ id: "private-source", text: "do not expose", truncated: true }] } });
    const claim = await claimed(h);
    const source = await mail(h, claim.leaseToken);
    expect(source.value).toMatchObject({ incomplete: true });
    expect(JSON.stringify(source.value)).not.toContain("do not expose");
    const completion = { ...claim, auth, brief: brief(claim.date, source.sourceId ?? "foreign"), errorCode: null };
    const first = await h.service.complete(completion);
    expect(first).toMatchObject({ kind: "published" });
    expect(await h.service.complete(completion)).toEqual(first);
    await expect(h.service.complete({ ...completion, errorCode: "changed" })).rejects.toMatchObject({ code: "completion_conflict" });
    expect(h.store.auth()?.generation).toBe(2);
    expect(h.service.edition().edition?.coverage).toEqual([{ account: "Work", product: "gmail", status: "truncated" }]);
    expect(h.service.edition().edition?.sources[0]?.url).toBeNull();
    expect(h.db.prepare<[], { context_json: string }>("SELECT context_json FROM web_brief_runs").get()?.context_json).toBe("{}");
    expect(h.db.prepare<[], { result_json: string | null }>("SELECT result_json FROM tool_executions").get()?.result_json).toBeNull();
    expect(h.db.prepare<[], { count: number }>("SELECT count(*) count FROM write_intents").get()?.count).toBe(0);
    expect(h.db.prepare<[], { count: number }>("SELECT count(*) count FROM jobs").get()?.count).toBe(0);
  });

  it("rejects Contacts and every write name before provider dispatch", async () => {
    const h = harness("all");
    const claim = await claimed(h);
    await expect(h.service.tool({ leaseToken: claim.leaseToken, callId: "contacts", name: "google.read", arguments: { account: "Work", product: "contacts", id: "contact" } }))
      .rejects.toMatchObject({ code: "contacts_not_allowed" });
    expect(h.calls).toEqual([]);
  });

  it("isolates runner, reader and admin routes without returning raw context or auth", async () => {
    const h = harness();
    const config = { runnerToken: "r".repeat(40), readerToken: "v".repeat(40), adminToken: "a".repeat(40) };
    const app = Fastify({ logger: false });
    registerWebBriefRoutes(app, { service: h.service, config });
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/internal/brief/edition" });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.headers["cache-control"]).toContain("no-store");
      expect((await app.inject({ method: "POST", url: "/internal/brief/claim", headers: { authorization: `Bearer ${config.readerToken}` }, payload: { requestId: "viewer" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/internal/brief/edition", headers: { authorization: `Bearer ${config.runnerToken}` } })).statusCode).toBe(401);
      const viewer = await app.inject({ method: "GET", url: "/internal/brief/edition", headers: { authorization: `Bearer ${config.readerToken}` } });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.json()).toEqual({ date: "2026-10-28", status: "empty", edition: null });
      expect(viewer.body).not.toMatch(/canonical|token|auth|memory/u);
    } finally { await app.close(); }
  });

  it("rebuilds v11 runs without losing legacy columns or child execution evidence", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, 11);
      db.pragma("foreign_keys = ON");
      db.exec(`INSERT INTO jobs(id,chat_id,type,subject_id,payload_json,status,attempts,
        available_at_ms,lease_token,lease_expires_at_ms,trace_id,run_id,inbound_sequence,
        last_error,created_at_ms,updated_at_ms)
        VALUES('job_old','scheduled','daily_brief','2026-10-27','{}','succeeded',3,
          1,NULL,NULL,'trace_old',NULL,NULL,NULL,1,2);
        INSERT INTO agent_runs(id,inbound_id,scheduled_job_id,trace_id,phase,model_requests,
          maintenance_requests,tool_calls,provider_writes,deadline_at_ms,transcript_bytes,
          memory_maintenance_status,memory_before_digest,memory_after_digest,ambiguous_write_id,
          final_response,failure_code,created_at_ms,updated_at_ms,request_scope)
        VALUES('run_old',NULL,'job_old','trace_old','completed',7,2,3,0,99,111,
          'updated','before_digest','after_digest',NULL,'kept response',NULL,1,2,'read');
        INSERT INTO tool_executions(id,run_id,tool_call_id,tool_name,arguments_json,connection_id,
          operation_class,status,result_json,write_intent_id,created_at_ms,updated_at_ms)
        VALUES('tool_old','run_old','call_old','gmail.search','{"account":"Work"}',NULL,
          'read','succeeded','{"retained":true}',NULL,1,2);`);
      const before = db.prepare<[], Record<string, unknown>>("SELECT * FROM agent_runs WHERE id='run_old'").get();
      const child = db.prepare("SELECT * FROM tool_executions WHERE id='tool_old'").get();
      runMigrations(db);
      expect(db.prepare("SELECT * FROM agent_runs WHERE id='run_old'").get()).toEqual({ ...before, web_brief_id: null });
      expect(db.prepare("SELECT * FROM tool_executions WHERE id='tool_old'").get()).toEqual(child);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() => db.prepare("UPDATE agent_runs SET web_brief_id='nonexistent' WHERE id='run_old'").run()).toThrow();
    } finally { db.close(); }
  });

  it("is disabled by default and rejects partial or shared token configuration", () => {
    expect(loadWebBriefConfig({})).toBeNull();
    expect(() => loadWebBriefConfig({ WEB_BRIEF_RUNNER_TOKEN: "r".repeat(40) })).toThrow();
    expect(() => loadWebBriefConfig({ WEB_BRIEF_RUNNER_TOKEN: "r".repeat(40), WEB_BRIEF_READER_TOKEN: "r".repeat(40), WEB_BRIEF_ADMIN_TOKEN: "a".repeat(40) })).toThrow();
  });
});

const previewWeather = { location: "UCLA / Westwood", timeZone: "America/Los_Angeles", days: [
  { date: "2026-10-28", highF: 72, lowF: null, condition: "Sunny" },
] };
async function previewClaimed(h: WebBriefHarness, requestId = "preview-one") {
  vi.spyOn(h.service.input, "loadContext").mockResolvedValue({ memory: "canonical user preferences", weather: previewWeather });
  await h.service.bootstrap(auth);
  return claimResult.parse(await h.service.claimPreview(requestId));
}

describe("non-publishing fixed real-data preview", () => {
  it("keeps scheduled work outside its window while allowing an explicit preview with the same global lease", async () => {
    const h = harness();
    vi.setSystemTime(new Date("2026-10-28T20:00:00Z"));
    await h.service.bootstrap(auth);
    expect(await h.service.claim("scheduled-outside")).toEqual({ kind: "not_due", date: "2026-10-28" });
    expect(h.store.auth()?.state).toBe("ready");
    const claim = claimResult.parse(await h.service.claimPreview("manual-afternoon"));
    expect(claim.date).toBe("2026-10-28");
    expect(await h.service.claimPreview("parallel-preview")).toMatchObject({ kind: "busy" });
    expect(h.db.prepare("SELECT purpose FROM web_brief_runs").get()).toEqual({ purpose: "preview" });
    expect(() => h.db.prepare("UPDATE web_brief_runs SET purpose='daily'").run()).toThrow("web_brief_purpose_immutable");
  });

  it("returns one bounded artifact, retains metadata only, and does not consume the daily edition date", async () => {
    const h = harness();
    const claim = await previewClaimed(h);
    const source = await mail(h, claim.leaseToken);
    const completion = { ...claim, auth, brief: { todos: [{ title: "Review the requested draft", detail: null, due: null, sourceIds: [source.sourceId ?? "foreign"] }] }, errorCode: null };
    const response = await h.service.completePreview(completion);
    expect(response).toMatchObject({ kind: "previewed", errorCode: null, preview: {
      version: 1, date: "2026-10-28", timeZone: "America/Los_Angeles", weather: previewWeather, calendar: [],
      todos: [{ title: "Review the requested draft", detail: null, due: null, sourceIds: [source.sourceId] }],
      coverage: [{ account: "Work", product: "gmail", status: "complete" }],
    } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(262_144);
    expect(await h.service.completePreview(completion)).toEqual({ kind: "previewed", date: claim.date, errorCode: null });
    const retained = h.db.prepare<[], { completion_json: string; context_json: string }>("SELECT completion_json,context_json FROM web_brief_runs").get();
    expect(retained?.completion_json).not.toContain("Review the requested draft");
    expect(retained?.context_json).toBe("{}");
    expect(h.service.edition().edition).toBeNull();
    expect(h.db.prepare("SELECT * FROM web_brief_editions").all()).toEqual([]);
    const daily = claimResult.parse(await h.service.claim("same-date-daily"));
    const dailySource = await mail(h, daily.leaseToken);
    expect(await h.service.complete({ ...daily, auth, brief: brief(daily.date, dailySource.sourceId ?? "foreign"), errorCode: null })).toMatchObject({ kind: "published" });
    expect(await h.service.claimPreview("preview-after-publication")).toMatchObject({ kind: "claimed" });
    expect(h.db.prepare<[], { count: number }>("SELECT count(*) count FROM write_intents").get()?.count).toBe(0);
    expect(h.db.prepare<[], { count: number }>("SELECT count(*) count FROM egress_messages").get()?.count).toBe(0);
  });

  it.each(["daily_to_preview", "preview_to_daily"])("refuses %s before checkpointing or consuming the lease", async (direction) => {
    const h = harness();
    const claim = direction === "daily_to_preview" ? await claimed(h) : await previewClaimed(h);
    const input = { ...claim, auth: { ...auth, tokens: { ...auth.tokens, refresh_token: "must-not-be-saved" } }, brief: { todos: [] }, errorCode: null };
    await expect(direction === "daily_to_preview" ? h.service.completePreview(input) : h.service.complete(input)).rejects.toMatchObject({ code: "purpose_mismatch" });
    expect(h.store.auth()?.generation).toBe(1);
    expect(h.store.auth()?.state).toBe("in_use");
    expect(h.db.prepare("SELECT state,completion_digest FROM web_brief_runs").get()).toEqual({ state: "running", completion_digest: null });
    expect(h.released).toEqual([]);
  });

  it.each([
    { brief: { todos: [], weather: { highF: 99 } }, code: "invalid_preview" },
    { brief: { todos: [{ title: "Unproven", detail: null, due: null, sourceIds: ["foreign"] }] }, code: "invalid_citation" },
    { brief: { todos: [{ title: "Bad date", detail: null, due: "2026-02-30", sourceIds: ["foreign"] }] }, code: "invalid_preview" },
    { brief: { todos: [] }, code: "source_coverage_missing" },
  ])("checkpoints valid rotated auth on invalid preview output ($code)", async ({ brief: draft, code }) => {
    const h = harness();
    const claim = await previewClaimed(h);
    const renewed = { ...auth, tokens: { ...auth.tokens, refresh_token: "preview-rotated-synthetic" } };
    expect(await h.service.completePreview({ ...claim, auth: renewed, brief: draft, errorCode: null })).toMatchObject({ kind: "failed", errorCode: code });
    const saved = h.store.auth();
    expect(saved?.generation).toBe(2);
    expect(saved === undefined ? null : h.store.openAuth(saved).tokens.refresh_token).toBe("preview-rotated-synthetic");
    expect(h.service.edition().edition).toBeNull();
  });

  it("seals the provider weather snapshot and ignores model-generated weather/calendar", async () => {
    const h = harness();
    const claim = await previewClaimed(h);
    const retained = h.db.prepare<[], { context_json: string }>("SELECT context_json FROM web_brief_runs").get()?.context_json ?? "";
    expect(retained).not.toContain("UCLA");
    expect(retained).not.toContain("Sunny");
    await mail(h, claim.leaseToken);
    expect(await h.service.completePreview({ ...claim, auth, brief: { todos: [], calendar: [] }, errorCode: null })).toMatchObject({ kind: "failed", errorCode: "invalid_preview" });
    expect(h.store.auth()?.state).toBe("ready");
  });

  it("projects only persisted exact-window normalized calendar reads and exposes unavailable coverage", async () => {
    const event = { eventId: "real-one", iCalUID: "underlying-one", calendar: { label: "Main", primary: true },
      summary: "Recorded meeting", location: "Room 1", start: { kind: "dateTime", value: "2026-10-28T16:00:00-07:00", timeZone: "America/Los_Angeles" },
      end: { kind: "dateTime", value: "2026-10-28T17:00:00-07:00", timeZone: "America/Los_Angeles" }, updatedAt: null };
    const h = harness("all", { results: [
      { product: "calendar", ok: true, events: [event], truncated: false },
      { product: "drive", ok: false, error: { code: "unavailable" } },
      { product: "tasks", ok: true, tasks: [], truncated: false },
    ] });
    const claim = await previewClaimed(h);
    await mail(h, claim.leaseToken);
    const args = { account: "Work", queries: [
      { product: "calendar", timeMin: claim.context.window.calendarStart, timeMax: claim.context.window.calendarEnd, maxResults: 20 },
      { product: "drive", modifiedAfter: claim.context.window.modifiedAfter, maxResults: 20 },
      { product: "tasks", dueBefore: claim.context.window.calendarEnd, includeCompleted: false, maxResults: 20 },
    ] };
    await h.service.tool({ leaseToken: claim.leaseToken, callId: "exact-google", name: "google.search", arguments: args });
    expect(await h.service.completePreview({ ...claim, auth, brief: { todos: [] }, errorCode: null })).toMatchObject({ kind: "previewed", preview: {
      weather: previewWeather, calendar: [{ title: event.summary, start: event.start.value, end: event.end.value, allDay: false, location: event.location }],
      coverage: expect.arrayContaining([{ account: "Work", product: "drive", status: "unavailable" }]),
    } });
  });

  it("keeps failed source reads visible as unavailable rather than requiring invented todos", async () => {
    const h = harness();
    const claim = await previewClaimed(h);
    vi.spyOn(h.service.input.tools, "execute").mockRejectedValue(new Error("private provider details"));
    await mail(h, claim.leaseToken);
    expect(await h.service.completePreview({ ...claim, auth, brief: { todos: [] }, errorCode: null })).toMatchObject({ kind: "previewed", preview: {
      todos: [], coverage: [{ account: "Work", product: "gmail", status: "unavailable" }],
    } });
  });

  it("fences preview routes with the runner token, not the reader token", async () => {
    const h = harness();
    const config = { runnerToken: "r".repeat(40), readerToken: "v".repeat(40), adminToken: "a".repeat(40) };
    const app = Fastify({ logger: false });
    registerWebBriefRoutes(app, { service: h.service, config });
    await h.service.bootstrap(auth);
    vi.setSystemTime(new Date("2026-10-28T20:00:00Z"));
    try {
      expect((await app.inject({ method: "POST", url: "/internal/brief/preview/claim", headers: { authorization: `Bearer ${config.readerToken}` }, payload: { requestId: "reader" } })).statusCode).toBe(401);
      const response = await app.inject({ method: "POST", url: "/internal/brief/preview/claim", headers: { authorization: `Bearer ${config.runnerToken}` }, payload: { requestId: "operator" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: "claimed", outputSchema: { required: ["todos"] } });
      expect(response.headers["cache-control"]).toContain("no-store");
    } finally { await app.close(); }
  });

  it("requires every Gmail account independently even when Notion has no tasks", async () => {
    const h = harness();
    h.service.input.connections.saveAuthorization({ traceId: newTraceId(), provider: "google", providerAccountId: "personal-private",
      safeLabel: "Personal", safeMetadata: {}, providerState: {}, capabilities: ["gmail.read"], credentials: { refreshToken: "synthetic" } });
    h.service.input.connections.saveAuthorization({ traceId: newTraceId(), provider: "notion", providerAccountId: "notes-private",
      safeLabel: "Notes", safeMetadata: {}, providerState: {}, capabilities: ["notion.search", "notion.fetch"], credentials: { accessToken: "synthetic" } });
    const claim = await previewClaimed(h);
    vi.spyOn(h.service.input.tools, "execute").mockImplementation(async ({ name }) => name === "notion.search"
      ? { workspace: { label: "Notes" }, result: { results: [], pages: [], truncated: false } }
      : { messages: [], messagesTruncated: false });
    await mail(h, claim.leaseToken);
    await h.service.tool({ leaseToken: claim.leaseToken, callId: "notes-empty", name: "notion.search", arguments: { workspace: "Notes", query: "tasks", pageSize: 10, hydrate: 3, view: "full" } });
    expect(await h.service.completePreview({ ...claim, auth, brief: { todos: [] }, errorCode: null })).toMatchObject({ kind: "failed", errorCode: "source_coverage_missing" });
    const second = claimResult.parse(await h.service.claimPreview("all-inboxes"));
    await mail(h, second.leaseToken);
    await h.service.tool({ leaseToken: second.leaseToken, callId: "personal-mail", name: "gmail.search", arguments: { account: "Personal", query: "newer_than:1d is:unread", maxResults: 20 } });
    await h.service.tool({ leaseToken: second.leaseToken, callId: "notes-empty", name: "notion.search", arguments: { workspace: "Notes", query: "tasks", pageSize: 10, hydrate: 3, view: "full" } });
    expect(await h.service.completePreview({ ...second, auth, brief: { todos: [] }, errorCode: null })).toMatchObject({ kind: "previewed", preview: {
      todos: [], coverage: expect.arrayContaining([
        { account: "Work", product: "gmail", status: "complete" },
        { account: "Personal", product: "gmail", status: "complete" },
        { account: "Notes", product: "notion", status: "complete" },
      ]),
    } });
  });

  it("rejects non-window calendar reads as coverage while still checkpointing preview auth", async () => {
    const h = harness("all", { results: [{ product: "calendar", ok: true, events: [] }, { product: "drive", ok: true }, { product: "tasks", ok: true }] });
    const claim = await previewClaimed(h);
    await mail(h, claim.leaseToken);
    await h.service.tool({ leaseToken: claim.leaseToken, callId: "wrong-window", name: "google.search", arguments: { account: "Work", queries: [
      { product: "calendar", timeMin: "2026-10-27T15:00:00Z", timeMax: claim.context.window.calendarEnd, maxResults: 20 },
      { product: "drive", modifiedAfter: claim.context.window.modifiedAfter, maxResults: 20 },
      { product: "tasks", dueBefore: claim.context.window.calendarEnd, includeCompleted: false, maxResults: 20 },
    ] } });
    expect(await h.service.completePreview({ ...claim, auth, brief: { todos: [] }, errorCode: null })).toMatchObject({ kind: "failed", errorCode: "source_coverage_missing" });
    expect(h.store.auth()?.generation).toBe(2);
  });
});

describe("deterministic preview calendar projection", () => {
  const base = { eventId: "event-one", iCalUID: "uid-one", calendar: { label: "Main", primary: true },
    summary: "Same title", location: null, updatedAt: null,
    start: { kind: "dateTime", value: "2026-10-28T09:00:00-07:00", timeZone: "America/Los_Angeles" },
    end: { kind: "dateTime", value: "2026-10-28T10:00:00-07:00", timeZone: "America/Los_Angeles" } };

  it("honors all-day exclusive dates, offsets, missing times and same-item identity without title collapse", () => {
    const projected = projectPreviewCalendar({ date: "2026-10-28", results: [
      { account: "Work", value: { ok: true, events: [
        base,
        { ...base, eventId: "distinct", iCalUID: "uid-two" },
        { ...base, eventId: "all-day", iCalUID: null, start: { kind: "date", value: "2026-10-28" }, end: { kind: "date", value: "2026-10-29" } },
        { ...base, eventId: "ended", iCalUID: null, start: { kind: "date", value: "2026-10-27" }, end: { kind: "date", value: "2026-10-28" } },
        { ...base, eventId: "tomorrow", iCalUID: null, start: { kind: "dateTime", value: "2026-10-29T01:00:00-07:00" } },
        { ...base, eventId: "missing-time", iCalUID: null, start: null, end: null },
        { ...base, eventId: "cancelled", iCalUID: null, status: "cancelled" },
      ] } },
      { account: "Personal", value: { ok: true, events: [{ ...base, eventId: "copy", start: { kind: "dateTime", value: "2026-10-28T16:00:00Z" } }] } },
    ] });
    expect(projected.calendar).toHaveLength(4);
    expect(new Set(projected.calendar.map((event) => event.id)).size).toBe(4);
    expect(projected.calendar[0]).toMatchObject({ allDay: true, start: "2026-10-28", end: "2026-10-29" });
    expect(projected.calendar.filter((event) => !event.allDay && event.start !== null)).toHaveLength(2);
    expect(projected.calendar.at(-1)).toMatchObject({ start: null, end: null, allDay: false });
    expect(projected.truncatedAccounts).toEqual(new Set(["Work"]));
    expect(JSON.stringify(projected.calendar)).not.toMatch(/Work|Personal|uid-one|Main/u);
  });

  it("marks missing or malformed calendar data incomplete rather than silently complete-empty", () => {
    const result = projectPreviewCalendar({ date: "2026-10-28", results: [
      { account: "Unavailable", value: { ok: false } },
      { account: "Missing", value: { ok: true } },
      { account: "Malformed", value: { ok: true, events: [{ ...base, start: { kind: "dateTime", value: "not-a-time" } }] } },
    ] });
    expect(result.calendar).toEqual([]);
    expect(result.truncatedAccounts).toEqual(new Set(["Unavailable", "Missing", "Malformed"]));
  });

  it("keeps recurring instances distinct and requires an occurrence start before cross-account UID merging", () => {
    const result = projectPreviewCalendar({ date: "2026-10-28", results: [
      { account: "Work", value: { ok: true, events: [
        base,
        { ...base, eventId: "second-instance", start: { kind: "dateTime", value: "2026-10-28T13:00:00-07:00" }, end: { kind: "dateTime", value: "2026-10-28T14:00:00-07:00" } },
        { ...base, eventId: "unknown-first", start: null, end: null },
      ] } },
      { account: "Personal", value: { ok: true, events: [{ ...base, eventId: "unknown-second", start: null, end: null }] } },
    ] });
    expect(result.calendar).toHaveLength(4);
    expect(result.calendar.filter((event) => event.start === null)).toHaveLength(2);
  });
});

describe("preview migration and normalized calendar identity", () => {
  it("backfills existing v12 runs as daily and prevents purpose changes", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, 12);
      db.exec(`INSERT INTO web_brief_runs(id,local_date,request_id,trace_id,state,lease_token_hash,
        lease_expires_at_ms,deadline_at_ms,credential_generation,context_json,created_at_ms,updated_at_ms)
        VALUES('legacy','2026-10-28','legacy-request','legacy-trace','failed','legacy-hash',1,1,1,'{}',1,1)`);
      runMigrations(db);
      expect(db.prepare("SELECT purpose FROM web_brief_runs WHERE id='legacy'").get()).toEqual({ purpose: "daily" });
      expect(() => db.prepare("UPDATE web_brief_runs SET purpose='preview' WHERE id='legacy'").run()).toThrow("web_brief_purpose_immutable");
      expect(() => db.prepare("UPDATE web_brief_runs SET purpose='unknown' WHERE id='legacy'").run()).toThrow();
    } finally { db.close(); }
  });

  it("projects Google iCalUID as application identity while keeping account identifiers out of events", () => {
    const result = parseCalendarEvents({ items: [{ id: "google-resource", iCalUID: "shared-occurrence@example.test",
      summary: "Recorded event", start: { date: "2026-10-28" }, end: { date: "2026-10-29" } }] },
    { id: "private-calendar@example.test", label: "Main", primary: true, description: null, accessRole: "owner", timeZone: "America/Los_Angeles" });
    expect(result.events[0]).toMatchObject({ eventId: "google-resource", iCalUID: "shared-occurrence@example.test",
      calendar: { label: "Main", primary: true }, start: { kind: "date", value: "2026-10-28" } });
    expect(JSON.stringify(result)).not.toContain("private-calendar");
  });
});
