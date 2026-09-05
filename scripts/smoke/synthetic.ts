// Synthetic Notion, Google, and conversation state for the inbound request matrix.
// Everything here is deterministic and offline; only DeepSeek is real.
import assert from "node:assert/strict";
import { z } from "zod";
import { newTraceId } from "../../src/core/ids.js";
import type { GmailApi, GmailClientProvider } from "../../src/gmail/client.js";
import type { GoogleWorkspaceApi, GoogleWorkspaceClientProvider } from "../../src/google/client.js";
import type { NotionClientProvider } from "../../src/notion/client.js";
import type { AssistantRuntime } from "../../src/runtime.js";

export const line = "+15550000001";
export const user = "+15550000002";

const day = 86_400_000;
export const isoDate = (offset: number): string =>
  new Date(Date.now() + offset * day).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------
// Notion: one "Daily tasks" page with dated checkbox sections plus a task archive.

export interface NotionOptions {
  yesterdayChecked?: boolean;
  fetchFails?: boolean;
  writeLoses?: boolean;
  truncatedFetch?: boolean;
}

export interface NotionWorld {
  clients: NotionClientProvider;
  pages: Map<string, string>;
  original: string;
  yesterday: string;
  today: string;
  createdTitles: string[];
  mutations(): number;
}

// The three upstream update shapes NotionToolService can emit. A patch must be unique in
// the current page; a replacement swaps the whole body; a property update touches no body.
const patchSchema = z.discriminatedUnion("command", [
  z.object({
    page_id: z.string(),
    command: z.literal("update_content"),
    content_updates: z.tuple([z.object({
      old_str: z.string().min(1),
      new_str: z.string(),
      replace_all_matches: z.literal(false),
    })]),
  }),
  z.object({ page_id: z.string(), command: z.literal("replace_content"), new_str: z.string() }),
  z.object({ page_id: z.string(), command: z.literal("update_properties"), properties: z.record(z.string(), z.unknown()) }),
]);
const createSchema = z.object({
  pages: z.array(z.object({ properties: z.object({ title: z.string().min(1) }).loose() }).loose()).length(1),
}).loose();

export const archivePage = "# Task archive\n- [ ] Clean restroom\n- [ ] Clean and organize room\n";

export function syntheticNotion(options: NotionOptions = {}): NotionWorld {
  const yesterday = `## ${isoDate(-1)}\n- [${options.yesterdayChecked === true ? "x" : " "}] Clean and organize room\n- [x] Wash car`;
  const today = `## ${isoDate(0)}\n- [ ] Clean restroom\n- [ ] Water plants\n- [ ] Clean and organize room`;
  const original = `# Daily tasks\n\n## ${isoDate(-2)}\n- [ ] Clean and organize room\n\n${yesterday}\n\n${today}\n`;
  const pages = new Map([["daily", original], ["archive", archivePage]]);
  const createdTitles: string[] = [];
  let mutations = 0;
  const clients: NotionClientProvider = {
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
            if (options.fetchFails === true) throw new Error("Synthetic Notion read unavailable");
            const { id } = z.object({ id: z.string() }).parse(argumentsValue);
            assert(pages.has(id), "Model fetched an unknown synthetic page");
            return { structuredContent: { id, text: pages.get(id), truncated: options.truncatedFetch === true } };
          }
          if (tool === "notion-create-pages") {
            const { pages: created } = createSchema.parse(argumentsValue);
            const title = created[0]?.properties.title ?? "";
            mutations += 1;
            pages.set("created_1", `# ${title}\n`);
            createdTitles.push(title);
            return { structuredContent: { pages: [{ id: "created_1", url: "https://notion.invalid/created_1" }] } };
          }
          assert.equal(tool, "notion-update-page", "Expected an update or a page creation");
          const patch = patchSchema.parse(argumentsValue);
          const source = pages.get(patch.page_id);
          assert(source !== undefined, "Model wrote an unknown page");
          if (patch.command === "update_content") {
            const [change] = patch.content_updates;
            const offset = source.indexOf(change.old_str);
            assert(offset >= 0 && source.indexOf(change.old_str, offset + 1) === -1, "Provider source must be unique");
            pages.set(patch.page_id, source.replace(change.old_str, change.new_str));
          } else if (patch.command === "replace_content") {
            pages.set(patch.page_id, patch.new_str);
          }
          mutations += 1;
          if (options.writeLoses === true) throw new Error("Synthetic response lost after acceptance");
          return { structuredContent: { id: patch.page_id, truncated: false } };
        },
      });
    },
  };
  return { clients, pages, original, yesterday, today, createdTitles, mutations: () => mutations };
}

// ---------------------------------------------------------------------------------------
// Google: one account with a small mailbox, a calendar, a few Drive files, contacts, tasks.

export interface GoogleOptions {
  gmailFails?: boolean;
  inboxSize?: number;
}

export interface GoogleWorld {
  gmailClients: GmailClientProvider;
  googleWorkspaceClients: GoogleWorkspaceClientProvider;
  calls: string[];
}

interface Mail { id: string; threadId: string; from: string; subject: string; body: string; ageMs: number; unread: boolean }

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

function mailbox(size: number): Mail[] {
  const fixed: Mail[] = [
    { id: "m_lee", threadId: "t_lee", from: "Prof. Lee <lee@example.test>", subject: "Assignment 3 deadline moved to Friday", body: "The deadline for assignment 3 is now Friday 5pm. Submit on the portal.", ageMs: 2 * 3_600_000, unread: true },
    { id: "m_alex_1", threadId: "t_alex", from: "Alex Rivera <alex@example.test>", subject: "Car wash saturday?", body: "Want to do the car wash saturday morning? I can pick you up at 9.", ageMs: 20 * 3_600_000, unread: true },
    { id: "m_alex_2", threadId: "t_alex", from: "Alex Rivera <alex@example.test>", subject: "Re: Car wash saturday?", body: "Actually make it 10, I have a thing at 9.", ageMs: 5 * 3_600_000, unread: true },
    { id: "m_news", threadId: "t_news", from: "Notion Team <team@notion.example>", subject: "What's new in Notion this month", body: "New database views, better search, and more.", ageMs: 30 * 3_600_000, unread: false },
  ];
  const filler: Mail[] = Array.from({ length: Math.max(0, size - fixed.length) }, (_, index) => ({
    id: `m_filler_${index}`, threadId: `t_filler_${index}`,
    from: `Sender ${index} <sender${index}@example.test>`,
    subject: `Weekly update ${index}: metrics, hiring, and roadmap notes`,
    body: `Update ${index}. Nothing urgent. ${"Details ".repeat(40)}`,
    ageMs: (index + 2) * 3_600_000, unread: index % 3 === 0,
  }));
  return [...fixed, ...filler];
}

function gmailMessage(mail: Mail, format: "metadata" | "full"): Record<string, unknown> {
  const sentAt = new Date(Date.now() - mail.ageMs);
  return {
    id: mail.id, threadId: mail.threadId, snippet: mail.body.slice(0, 80),
    internalDate: String(sentAt.getTime()),
    labelIds: mail.unread ? ["INBOX", "UNREAD"] : ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: mail.from }, { name: "To", value: "ben@example.test" },
        { name: "Subject", value: mail.subject }, { name: "Date", value: sentAt.toUTCString() },
        { name: "Message-ID", value: `<${mail.id}@example.test>` },
      ],
      ...(format === "full" ? { body: { size: mail.body.length, data: base64url(mail.body) } } : {}),
    },
  };
}

function matchesQuery(mail: Mail, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/u)
    .map((token) => token.replace(/^(from|to|subject):/u, ""))
    .filter((token) => token.length > 0 && !/^(is:|in:|has:|label:|newer_than:|older_than:|after:|before:|-)/u.test(token))
    .map((token) => token.replace(/^["']|["']$/gu, ""));
  if (terms.length === 0) return true;
  const haystack = `${mail.from} ${mail.subject} ${mail.body}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

export function syntheticGoogle(options: GoogleOptions = {}): GoogleWorld {
  const calls: string[] = [];
  const mails = mailbox(options.inboxSize ?? 4);
  const at = (hoursFromNow: number): string => new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
  const todayAt = (hour: number): string => `${isoDate(0)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const events = [
    { id: "ev_standup", status: "confirmed", summary: "Team standup", start: { dateTime: todayAt(10) }, end: { dateTime: todayAt(10) }, location: "Zoom" },
    { id: "ev_gym", status: "confirmed", summary: "Pull day (gym)", start: { dateTime: todayAt(18) }, end: { dateTime: todayAt(19) } },
    { id: "ev_dentist", status: "confirmed", summary: "Dentist", start: { dateTime: `${isoDate(1)}T15:00:00.000Z` }, end: { dateTime: `${isoDate(1)}T16:00:00.000Z` } },
  ];
  const files = [
    { id: "doc_logit", name: "Logit thought dump", mimeType: "application/vnd.google-apps.document", modifiedTime: at(-20), createdTime: at(-200), capabilities: { canDownload: true } },
    { id: "pdf_resume", name: "resume.pdf", mimeType: "application/pdf", modifiedTime: at(-72), createdTime: at(-400), size: "48213", capabilities: { canDownload: true } },
  ];
  const people = [{
    resourceName: "people/c_alex", names: [{ displayName: "Alex Rivera" }],
    emailAddresses: [{ value: "alex@example.test", type: "home" }],
    phoneNumbers: [{ value: "+15550000009", type: "mobile" }],
  }];
  const tasks = [
    { id: "task_dentist", title: "Call dentist to confirm", status: "needsAction", due: `${isoDate(0)}T00:00:00.000Z`, updated: at(-30) },
    { id: "task_reg", title: "Renew car registration", status: "needsAction", due: `${isoDate(1)}T00:00:00.000Z`, updated: at(-50) },
    { id: "task_done", title: "Pay rent", status: "completed", due: `${isoDate(-2)}T00:00:00.000Z`, completed: at(-40), updated: at(-40) },
  ];
  const gmail: GmailApi = {
    async listMessages(input) {
      calls.push(`gmail.list:${input.query}`);
      if (options.gmailFails === true) throw new Error("Synthetic Gmail unavailable");
      const matched = mails.filter((mail) => matchesQuery(mail, input.query)).slice(0, input.maxResults);
      return { data: { messages: matched.map((mail) => ({ id: mail.id, threadId: mail.threadId })), resultSizeEstimate: matched.length }, headers: {} };
    },
    async getMessage(input) {
      calls.push(`gmail.message:${input.messageId}`);
      const mail = mails.find((candidate) => candidate.id === input.messageId);
      assert(mail, "Model read an unknown synthetic message");
      return { data: gmailMessage(mail, input.format), headers: {} };
    },
    async getThread(input) {
      calls.push(`gmail.thread:${input.threadId}`);
      const thread = mails.filter((mail) => mail.threadId === input.threadId);
      assert(thread.length > 0, "Model read an unknown synthetic thread");
      return { data: { id: input.threadId, messages: thread.map((mail) => gmailMessage(mail, "full")) }, headers: {} };
    },
  };
  const workspace: GoogleWorkspaceApi = {
    async listCalendars() { calls.push("calendar.list"); return { data: { items: [{ id: "primary", summary: "Ben", primary: true, timeZone: "America/Los_Angeles" }] }, headers: {} }; },
    async listEvents(input) {
      calls.push(`calendar.events:${input.timeMin}..${input.timeMax}`);
      const min = Date.parse(input.timeMin); const max = Date.parse(input.timeMax);
      return { data: { items: events.filter((event) => { const start = Date.parse(event.start.dateTime); return start >= min && start <= max; }) }, headers: {} };
    },
    async listDriveFiles(input) {
      calls.push(`drive.list:${input.query}`);
      const named = /name contains '([^']+)'/u.exec(input.query)?.[1]?.toLowerCase();
      return { data: { files: files.filter((file) => named === undefined || file.name.toLowerCase().includes(named)).slice(0, input.maxResults) }, headers: {} };
    },
    async getDriveFile(input) {
      calls.push(`drive.file:${input.fileId}`);
      const file = files.find((candidate) => candidate.id === input.fileId);
      assert(file, "Model read an unknown synthetic file");
      return { data: file, headers: {} };
    },
    async exportDriveText(input) { calls.push(`drive.export:${input.fileId}`); return { data: { content: "# Logit thought dump\n\n- idea: log every rep, not every set\n- idea: weekly review on sundays\n", truncated: false }, headers: {} }; },
    async downloadDriveText(input) { calls.push(`drive.download:${input.fileId}`); return { data: { content: "(binary omitted)", truncated: false }, headers: {} }; },
    async warmContacts() { calls.push("contacts.warm"); return { data: { results: [] }, headers: {} }; },
    async searchContacts(input) {
      calls.push(`contacts.search:${input.query}`);
      const needle = input.query.toLowerCase();
      return { data: { results: people.filter((person) => JSON.stringify(person).toLowerCase().includes(needle)).map((person) => ({ person })) }, headers: {} };
    },
    async getContact(input) {
      calls.push(`contacts.get:${input.contactId}`);
      const person = people.find((candidate) => candidate.resourceName.endsWith(input.contactId));
      assert(person, "Model read an unknown synthetic contact");
      return { data: person, headers: {} };
    },
    async listTaskLists() { calls.push("tasks.lists"); return { data: { items: [{ id: "list_main", title: "My Tasks", updated: at(-1) }] }, headers: {} }; },
    async getTaskList(input) { calls.push(`tasks.list:${input.taskListId}`); return { data: { id: "list_main", title: "My Tasks" }, headers: {} }; },
    async listTasks(input) {
      calls.push(`tasks.items:${input.taskListId}`);
      const before = input.dueBefore === undefined ? Number.POSITIVE_INFINITY : Date.parse(input.dueBefore);
      return { data: { items: tasks.filter((task) => (input.includeCompleted || task.status !== "completed") && Date.parse(task.due) <= before) }, headers: {} };
    },
    async getTask(input) {
      calls.push(`tasks.get:${input.taskId}`);
      const task = tasks.find((candidate) => candidate.id === input.taskId);
      assert(task, "Model read an unknown synthetic task");
      return { data: task, headers: {} };
    },
  };
  return {
    calls,
    gmailClients: { async forConnection() { return gmail; } },
    googleWorkspaceClients: { async forConnection() { return workspace; } },
  };
}

// ---------------------------------------------------------------------------------------
// Conversation state seeded straight into SQLite.

type Db = AssistantRuntime["database"]["db"];

function insertInbound(db: Db, row: {
  inbound: string; delivery: string; provider: string; sequence: number; state: string;
  text: string; trace: string; at: number;
}): void {
  const values = {
    ...row, chat: user, handle: line,
    attachment: JSON.stringify({ kind: "message", providerMessageId: row.provider, sentAtMs: row.at, updatedAtMs: row.at, mediaAvailable: false }),
  };
  db.prepare<typeof values>(`
    INSERT INTO webhook_deliveries(
      id, provider_delivery_id, provider_message_id, event_kind,
      line_id, line_handle, normalized_json, trace_id, received_at_ms
    ) VALUES (@delivery, @delivery, @provider, 'message', @handle, @handle, '{}', @trace, @at)
  `).run(values);
  db.prepare<typeof values>(`
    INSERT INTO inbound_messages(
      id, delivery_id, provider_message_id, chat_id, guid, sender, line_id, line_handle,
      sequence, state, text, is_audio, attachment_json, trace_id, created_at_ms, updated_at_ms
    ) VALUES (
      @inbound, @delivery, @provider, @chat, @provider, @chat, @handle, @handle,
      @sequence, @state, @text, 0, @attachment, @trace, @at, @at
    )
  `).run(values);
}

// Earlier accepted requests whose runs never replied: inbound rows only, no agent run and
// therefore no assistant turn, so history carries no delivered claim and no pending work.
export function seedFailedHistory(db: Db, texts: readonly string[]): void {
  for (const [index, text] of texts.entries()) {
    const suffix = `hist_${index + 1}`;
    insertInbound(db, {
      inbound: `in_${suffix}`, delivery: `wd_${suffix}`, provider: `sb_${suffix}`,
      sequence: index + 1, state: "blocked", text, trace: newTraceId(),
      at: Date.now() - (texts.length - index) * 600_000,
    });
  }
}

export interface SeededExchange {
  question: string;
  reply: string;
  ageMs: number;
  state: "delivered" | "delivery_unknown";
}

// One completed exchange right before the current message: Annie's delivered (or not)
// model-authored reply to the previous accepted message, aged as the case requires.
export function seedDeliveredExchange(db: Db, exchange: SeededExchange): void {
  const at = Date.now() - exchange.ageMs;
  const trace = newTraceId();
  insertInbound(db, {
    inbound: "in_offer", delivery: "wd_offer", provider: "sb_offer", sequence: 1_000,
    state: "done", text: exchange.question, trace, at,
  });
  const run = { run: "run_offer", inbound: "in_offer", egress: "eg_offer", trace, at, reply: exchange.reply, state: exchange.state, chat: user, handle: line };
  db.prepare<typeof run>(`
    INSERT INTO agent_runs(
      id, inbound_id, trace_id, phase, deadline_at_ms, memory_maintenance_status,
      final_response, request_scope, created_at_ms, updated_at_ms
    ) VALUES (@run, @inbound, @trace, 'completed', @at, 'unchanged', @reply, 'read', @at, @at)
  `).run(run);
  db.prepare<typeof run>(`
    INSERT INTO egress_messages(
      id, run_id, trace_id, recipient_handle, line_handle, body, purpose, state,
      attempt_count, created_at_ms, updated_at_ms
    ) VALUES (@egress, @run, @trace, @chat, @handle, @reply, 'reply', @state, 1, @at, @at)
  `).run(run);
}
