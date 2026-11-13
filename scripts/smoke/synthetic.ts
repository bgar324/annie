// Synthetic Notion, Google, and conversation state for the inbound request matrix.
// Everything here is deterministic and offline; only DeepSeek is real.
import assert from "node:assert/strict";
import { z } from "zod";
import { newTraceId } from "../../src/core/ids.js";
import type { GmailApi, GmailClientProvider } from "../../src/gmail/client.js";
import type { GoogleWorkspaceApi, GoogleWorkspaceClientProvider } from "../../src/google/client.js";
import type { NotionClientProvider } from "../../src/notion/client.js";
import type { AssistantRuntime } from "../../src/runtime.js";
import type { ProviderFetch } from "../../src/providers/fetch.js";
import { createPdf } from "../../tests/fixtures/pdf.js";

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
  taskPage?: { title: string; text: string };
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
  const original = options.taskPage?.text ?? `# Daily tasks\n\n## ${isoDate(-2)}\n- [ ] Clean and organize room\n\n${yesterday}\n\n${today}\n`;
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
              { id: "daily", title: options.taskPage?.title ?? "Daily tasks" }, { id: "archive", title: "Task archive" },
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

// Website tasks stay in memory. No network request reaches a todo server.
interface SyntheticTodo {
  id: string;
  title: string;
  notes: string;
  dueDate: string | null;
  completedAt: string | null;
  position: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TodoWorld {
  fetch: ProviderFetch;
  tasks: SyntheticTodo[];
  calls: string[];
}

export interface TodoOptions {
  unavailable?: boolean;
  completedTitle?: string;
  noOpenTasks?: boolean;
  openTitles?: readonly string[];
}

export function syntheticTodo(token: string, options: TodoOptions = {}): TodoWorld {
  const now = new Date().toISOString();
  const tasks: SyntheticTodo[] = (options.noOpenTasks === true ? [] : options.openTitles ?? ["Buy tea"]).map(
    (title, index) => ({
      id: `09ce4aaa-5e5b-4569-a9e0-${String(index + 1).padStart(12, "0")}`, title, notes: "",
      dueDate: isoDate(0), completedAt: null, position: index,
      revision: 1, createdAt: now, updatedAt: now,
    }),
  );
  if (options.completedTitle !== undefined) {
    tasks.push({
      id: "f1b72da1-169b-4557-b23a-fdab8b3b9bfb", title: options.completedTitle, notes: "",
      dueDate: isoDate(-1), completedAt: new Date(Date.now() - day).toISOString(), position: 1,
      revision: 2, createdAt: now, updatedAt: now,
    });
  }
  const calls: string[] = [];
  const create = z.object({
    title: z.string().min(1), notes: z.string().optional(),
    dueDate: z.iso.date().nullable().optional(),
  }).strict();
  return {
    tasks, calls,
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://todo.invalid");
      assert(url.pathname === "/api/todos" || /^\/api\/todos\/[a-f0-9-]{36}$/u.test(url.pathname),
        "Synthetic todo path must identify the collection or one task");
      assert(request.headers.get("authorization") === `Bearer ${token}`, "Synthetic todo authentication required");
      assert.equal(request.redirect, "error");
      calls.push(request.method);
      if (request.method === "PATCH") {
        assert(request.headers.has("idempotency-key"), "Website writes require a durable idempotency key");
        const args = z.object({
          expectedRevision: z.number().int().min(1), completed: z.boolean(),
        }).strict().parse(await request.json());
        const task = tasks.find((candidate) => url.pathname === `/api/todos/${candidate.id}`);
        if (task === undefined) return Response.json({ error: "not_found" }, { status: 404 });
        if (task.revision !== args.expectedRevision) return Response.json({ error: "conflict" }, { status: 409 });
        task.completedAt = args.completed ? new Date().toISOString() : null;
        task.revision += 1;
        task.updatedAt = new Date().toISOString();
        return Response.json({ todo: task });
      }
      if (request.method === "GET") {
        if (options.unavailable === true) return new Response("", { status: 503 });
        const dueDate = url.searchParams.get("dueDate");
        const status = url.searchParams.get("status") ?? "all";
        return Response.json({ todos: tasks.filter((task) =>
          (dueDate === null || task.dueDate === dueDate) &&
          (status === "all" || (status === "open" ? task.completedAt === null : task.completedAt !== null))) });
      }
      assert.equal(request.method, "POST", "Only list/create/complete are allowed by this synthetic website");
      assert(request.headers.has("idempotency-key"), "Website writes require a durable idempotency key");
      const args = create.parse(await request.json());
      const task: SyntheticTodo = {
        id: "cfc85dde-ae18-44e3-8e8d-6c3703890b64", title: args.title, notes: args.notes ?? "",
        dueDate: args.dueDate ?? null, completedAt: null,
        position: tasks.length, revision: 1, createdAt: now, updatedAt: now,
      };
      tasks.push(task);
      return Response.json({ todo: task }, { status: 201 });
    },
  };
}

// ---------------------------------------------------------------------------------------
// Google: one account with a small mailbox, a calendar, a few Drive files, contacts, tasks.

export interface GoogleOptions {
  gmailFails?: boolean;
  inboxSize?: number;
  mailboxScenario?: "brief_late_actions" | "brief_byte_budget" | "pdf_reimbursement";
}

export interface GoogleWorld {
  gmailClients: GmailClientProvider;
  googleWorkspaceClients: GoogleWorkspaceClientProvider;
  calls: string[];
}

interface Mail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  ageMs: number;
  unread: boolean;
  folder?: "SPAM" | "TRASH";
  attachment?: { id: string; filename: string; bytes: Uint8Array };
}

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

// Match the runner's mocked LA morning, not the wall-clock hour when the smoke starts.
function briefMorning(nowMs: number, dayOffset: number): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  const localDate = new Date(`${parts.year}-${parts.month}-${parts.day}T08:00:00.000Z`);
  localDate.setUTCDate(localDate.getUTCDate() + dayOffset);
  const target = localDate.getTime();
  let morning = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = Object.fromEntries(formatter.formatToParts(new Date(morning)).map((part) => [part.type, part.value]));
    morning += target - Date.parse(`${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}:${local.second}.000Z`);
  }
  return morning;
}

function briefMailbox(nowMs: number): Mail[] {
  const start = briefMorning(nowMs, -1);
  const end = briefMorning(nowMs, 0);
  const mail = (id: string, sentAtMs: number, subject: string, body: string): Mail => ({
    id, threadId: `t_${id}`, from: "Updates <updates@example.test>", subject, body,
    ageMs: nowMs - sentAtMs, unread: false,
  });
  return [
    mail("m_after_window", end + 1_000, "Aurora scholarship application needed", "Submit the Aurora scholarship application."),
    mail("m_at_window_end", end, "Cobalt grant application needed", "Submit the Cobalt grant application."),
    ...Array.from({ length: 22 }, (_, index) => ({
      ...mail(`m_brief_news_${index}`, end - (index + 1) * 30 * 60_000,
        `Community newsletter ${index}`, "A community photo digest. No action, deadline, invitation, or response needed."),
      unread: true,
    })),
    {
      ...mail("m_brief_interview", start + 60_000, "Meridian interview scheduling: send your availability",
        "Meridian recruiting would like to schedule your engineering interview. Reply with three available time slots by tomorrow. You have read this email but have not replied."),
      from: "Meridian Recruiting <recruiting@meridian.example.test>",
    },
    {
      ...mail("m_brief_github", start, "GitHub invitation to join the lattice-labs organization",
        "lattice-labs invited you to join their GitHub organization. Accept the invitation from your GitHub invitations page before it expires tomorrow. You have read this email but have not accepted."),
      from: "GitHub <noreply@github.example.test>",
    },
    mail("m_before_window", start - 1_000, "Saffron fellowship application needed", "Submit the Saffron fellowship application."),
    { ...mail("m_brief_spam", end - 60_000, "Topaz prize claim needed", "Claim the Topaz prize."), folder: "SPAM" },
    { ...mail("m_brief_trash", end - 60_000, "Onyx survey response needed", "Complete the Onyx survey."), folder: "TRASH" },
  ];
}

function budgetMailbox(nowMs: number): Mail[] {
  const end = briefMorning(nowMs, 0);
  const digests: Mail[] = Array.from({ length: 180 }, (_, index) => ({
    id: `m_budget_digest_${index}`, threadId: `t_budget_digest_${index}`,
    from: `Community digest ${"regional chapter ".repeat(18)}<digest${index}@example.test>`,
    subject: `Community archive ${index}: ${"photos, reports, and meeting notes; ".repeat(24)}`,
    body: "A routine archived community digest. There is no pending request or deadline.",
    ageMs: nowMs - (end - (index + 1) * 60_000), unread: false,
  }));
  return [...digests, {
    id: "m_budget_hidden_interview", threadId: "t_budget_hidden_interview",
    from: "Sequoia Recruiting <recruiting@sequoia.example.test>",
    subject: "Sequoia interview: send availability",
    body: "Reply with your availability to schedule the interview.",
    ageMs: nowMs - (end - 181 * 60_000), unread: false,
  }];
}

function reimbursementMailbox(): Mail[] {
  return [{
    id: "m_costar_onsite", threadId: "t_costar_onsite",
    from: "CoStar Recruiting <recruiting@costar.example.test>",
    subject: "CoStar onsite interview travel reimbursement policy",
    body: "For your CoStar onsite interview travel reimbursement process, please read the attached Travel and Expense Policy.pdf.",
    ageMs: 2 * 3_600_000, unread: false,
    attachment: {
      id: "a_travel_policy", filename: "Travel and Expense Policy.pdf",
      bytes: createPdf([[
        "Travel and Expense Policy",
        "Submit itemized receipts to candidate-expenses.example.test",
        "within 14 days of your onsite.",
      ]]),
    },
  }];
}

function gmailMessage(mail: Mail, format: "metadata" | "full", nowMs: number): Record<string, unknown> {
  const sentAt = new Date(nowMs - mail.ageMs);
  return {
    id: mail.id, threadId: mail.threadId, snippet: mail.body.slice(0, 80),
    internalDate: String(sentAt.getTime()),
    labelIds: [mail.folder ?? "INBOX", ...(mail.unread ? ["UNREAD"] : [])],
    payload: {
      mimeType: mail.attachment === undefined ? "text/plain" : "multipart/mixed",
      headers: [
        { name: "From", value: mail.from }, { name: "To", value: "ben@example.test" },
        { name: "Subject", value: mail.subject }, { name: "Date", value: sentAt.toUTCString() },
        { name: "Message-ID", value: `<${mail.id}@example.test>` },
      ],
      ...(format === "full" ? mail.attachment === undefined
        ? { body: { size: mail.body.length, data: base64url(mail.body) } }
        : { parts: [
          { mimeType: "text/plain", body: { size: mail.body.length, data: base64url(mail.body) } },
          {
            mimeType: "application/pdf", filename: mail.attachment.filename,
            body: { size: mail.attachment.bytes.byteLength, attachmentId: mail.attachment.id },
          },
        ] } : {}),
    },
  };
}

function matchesQuery(mail: Mail, query: string, nowMs: number): boolean {
  const sentAtSeconds = (nowMs - mail.ageMs) / 1_000;
  const after = /(?:^|\s)after:(\d+)(?:\s|$)/u.exec(query)?.[1];
  const before = /(?:^|\s)before:(\d+)(?:\s|$)/u.exec(query)?.[1];
  if (after !== undefined && sentAtSeconds <= Number(after)) return false;
  if (before !== undefined && sentAtSeconds >= Number(before)) return false;
  if (/(?:^|\s)is:unread(?:\s|$)/iu.test(query) && !mail.unread) return false;
  if (/(?:^|\s)is:read(?:\s|$)/iu.test(query) && mail.unread) return false;
  for (const match of query.matchAll(/(?:^|\s)(newer_than|older_than):(\d+)([dhmy])(?:\s|$)/giu)) {
    const unit = match[3]?.toLowerCase();
    const duration = Number(match[2]) * (unit === "h" ? 3_600_000 : unit === "m" ? 30 * day : unit === "y" ? 365 * day : day);
    if (match[1]?.toLowerCase() === "newer_than" ? mail.ageMs >= duration : mail.ageMs <= duration) return false;
  }
  if (mail.folder !== undefined) return false;
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
  const nowMs = Date.now();
  const mails = options.mailboxScenario === "brief_late_actions"
    ? briefMailbox(nowMs)
    : options.mailboxScenario === "brief_byte_budget" ? budgetMailbox(nowMs)
    : options.mailboxScenario === "pdf_reimbursement" ? reimbursementMailbox()
    : mailbox(options.inboxSize ?? 4);
  const date = (offset: number): string => new Date(nowMs + offset * day).toISOString().slice(0, 10);
  const at = (hoursFromNow: number): string => new Date(nowMs + hoursFromNow * 3_600_000).toISOString();
  const todayAt = (hour: number): string => `${date(0)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const events = [
    { id: "ev_standup", status: "confirmed", summary: "Team standup", start: { dateTime: todayAt(10) }, end: { dateTime: todayAt(10) }, location: "Zoom" },
    { id: "ev_gym", status: "confirmed", summary: "Pull day (gym)", start: { dateTime: todayAt(18) }, end: { dateTime: todayAt(19) } },
    { id: "ev_dentist", status: "confirmed", summary: "Dentist", start: { dateTime: `${date(1)}T15:00:00.000Z` }, end: { dateTime: `${date(1)}T16:00:00.000Z` } },
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
    { id: "task_dentist", title: "Call dentist to confirm", status: "needsAction", due: `${date(0)}T00:00:00.000Z`, updated: at(-30) },
    { id: "task_reg", title: "Renew car registration", status: "needsAction", due: `${date(1)}T00:00:00.000Z`, updated: at(-50) },
    { id: "task_done", title: "Pay rent", status: "completed", due: `${date(-2)}T00:00:00.000Z`, completed: at(-40), updated: at(-40) },
  ];
  const gmail: GmailApi = {
    async listMessages(input) {
      calls.push(`gmail.list:${input.query}`);
      if (options.gmailFails === true) throw new Error("Synthetic Gmail unavailable");
      const matched = mails.filter((mail) => matchesQuery(mail, input.query, nowMs));
      const offset = input.pageToken === undefined ? 0 : Number(input.pageToken);
      assert(Number.isSafeInteger(offset) && offset >= 0, "Invalid synthetic Gmail page token");
      assert(Number.isInteger(input.maxResults) && input.maxResults > 0 && input.maxResults <= 500,
        "Provider page size must be within Gmail's 1–500 range");
      const page = matched.slice(offset, offset + Math.min(input.maxResults, 20));
      calls.push(`gmail.page:${offset}:${page.map((mail) => mail.id).join(",")}`);
      const nextOffset = offset + page.length;
      return {
        data: {
          messages: page.map((mail) => ({ id: mail.id, threadId: mail.threadId })),
          resultSizeEstimate: matched.length,
          ...(nextOffset < matched.length ? { nextPageToken: String(nextOffset) } : {}),
        },
        headers: {},
      };
    },
    async getMessage(input) {
      calls.push(`gmail.message:${input.messageId}`);
      const mail = mails.find((candidate) => candidate.id === input.messageId);
      assert(mail, "Model read an unknown synthetic message");
      return { data: gmailMessage(mail, input.format, nowMs), headers: {} };
    },
    async getThread(input) {
      calls.push(`gmail.thread:${input.threadId}`);
      const thread = mails.filter((mail) => mail.threadId === input.threadId);
      assert(thread.length > 0, "Model read an unknown synthetic thread");
      return { data: { id: input.threadId, messages: thread.map((mail) => gmailMessage(mail, "full", nowMs)) }, headers: {} };
    },
    async getAttachment(input) {
      calls.push(`gmail.attachment:${input.messageId}:${input.attachmentId}`);
      input.signal?.throwIfAborted();
      const attachment = mails.find((mail) => mail.id === input.messageId)?.attachment;
      assert(attachment !== undefined && attachment.id === input.attachmentId,
        "Unexpected synthetic Gmail attachment request");
      return {
        data: { size: attachment.bytes.byteLength, data: Buffer.from(attachment.bytes).toString("base64url") },
        headers: {},
      };
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
  /** A failed turn: the request earned this scope, then the failure notice was delivered. */
  failedScope?: "notion_write" | "read";
}

// One completed exchange right before the current message: Annie's delivered (or not)
// model-authored reply, or a delivered failure notice for the user's own request, aged as
// the case requires.
export function seedDeliveredExchange(db: Db, exchange: SeededExchange): void {
  const at = Date.now() - exchange.ageMs;
  const trace = newTraceId();
  const failed = exchange.failedScope !== undefined;
  insertInbound(db, {
    inbound: "in_offer", delivery: "wd_offer", provider: "sb_offer", sequence: 1_000,
    state: failed ? "blocked" : "done", text: exchange.question, trace, at,
  });
  const run = {
    run: "run_offer", inbound: "in_offer", egress: "eg_offer", trace, at, reply: exchange.reply, state: exchange.state,
    chat: user, handle: line, phase: failed ? "blocked" : "completed", scope: exchange.failedScope ?? "read",
    finalResponse: failed ? null : exchange.reply, failureCode: failed ? "tool_not_allowed" : null,
    purpose: failed ? "failure" : "reply",
  };
  db.prepare<typeof run>(`
    INSERT INTO agent_runs(
      id, inbound_id, trace_id, phase, deadline_at_ms, memory_maintenance_status,
      final_response, failure_code, request_scope, created_at_ms, updated_at_ms
    ) VALUES (@run, @inbound, @trace, @phase, @at, 'unchanged', @finalResponse, @failureCode, @scope, @at, @at)
  `).run(run);
  db.prepare<typeof run>(`
    INSERT INTO egress_messages(
      id, run_id, trace_id, recipient_handle, line_handle, body, purpose, state,
      attempt_count, created_at_ms, updated_at_ms
    ) VALUES (@egress, @run, @trace, @chat, @handle, @reply, @purpose, @state, 1, @at, @at)
  `).run(run);
}
