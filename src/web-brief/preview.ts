import { z } from "zod";
import type { DailyWeather } from "../messages/weather.js";
import { digest } from "./store.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
});
const timestamp = z.string().datetime({ offset: true });
export const previewDraftSchema = z.object({
  todos: z.array(z.object({
    title: z.string().trim().min(1).max(160),
    detail: z.string().max(2_048).nullable(),
    due: z.union([date, timestamp]).nullable(),
    sourceIds: z.array(z.string().min(1).max(128)).min(1).max(32),
    references: z.array(z.object({
      sourceId: z.string().min(1).max(128),
      itemId: z.string().min(1).max(2_048),
    }).strict()).max(32),
  }).strict()).max(20),
}).strict();
export const previewOutputSchema = {
  type: "object", additionalProperties: false, required: ["todos"],
  properties: { todos: { type: "array", maxItems: 20, items: {
    type: "object", additionalProperties: false, required: ["title", "detail", "due", "sourceIds", "references"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      detail: { type: ["string", "null"], maxLength: 2048 },
      due: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "string", format: "date-time" }, { type: "null" }] },
      sourceIds: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 } },
      references: { type: "array", maxItems: 32, items: {
        type: "object", additionalProperties: false, required: ["sourceId", "itemId"],
        properties: { sourceId: { type: "string", minLength: 1, maxLength: 128 }, itemId: { type: "string", minLength: 1, maxLength: 2048 } },
      } },
    },
  } } },
};
export const previewWeatherSchema = z.union([
  z.object({ location: z.string().max(512), timeZone: z.string().max(128), days: z.array(z.object({
    date, highF: z.number().finite().nullable(), lowF: z.number().finite().nullable(), condition: z.string().max(2_048),
  }).strict()).max(16) }).strict(),
  z.object({ location: z.string().max(512), error: z.enum(["weather_unavailable", "location_not_found"]) }).strict(),
  z.object({ location: z.string().max(512), error: z.literal("location_ambiguous"), candidates: z.array(z.string().max(512)).max(32) }).strict(),
]);
export interface PreviewArtifact {
  version: 1;
  date: string;
  generatedAt: string;
  timeZone: "America/Los_Angeles";
  weather: DailyWeather;
  calendar: { id: string; title: string; start: string | null; end: string | null; allDay: boolean; location: string | null }[];
  todos: (Omit<z.infer<typeof previewDraftSchema>["todos"][number], "references"> & {
    id: string; links: { url: string; label: string }[];
  })[];
  coverage: { account: string; product: string; status: "complete" | "unavailable" | "truncated" }[];
}

const eventTime = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), value: date }),
  z.object({ kind: z.literal("dateTime"), value: timestamp, timeZone: z.string().nullable().optional() }),
]);
// These are application-normalized Google fields, never SDK payloads. Missing times stay missing.
const calendarEvent = z.object({
  eventId: z.string().min(1).max(2_048),
  iCalUID: z.string().min(1).max(2_048).nullable().optional(),
  calendar: z.object({ label: z.string().max(512), primary: z.boolean() }),
  status: z.string().nullable().optional(), summary: z.string().max(512), location: z.string().max(512).nullable(),
  start: eventTime.nullable().optional(), end: eventTime.nullable().optional(), updatedAt: timestamp.nullable().optional(),
});
const calendarResult = z.object({ ok: z.literal(true), events: z.array(z.unknown()).max(256) });
const pacificDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

export function projectPreviewCalendar(input: { date: string; results: { account: string; value: unknown }[] }): {
  calendar: PreviewArtifact["calendar"]; truncatedAccounts: Set<string>;
} {
  const selected = new Map<string, { event: PreviewArtifact["calendar"][number]; updated: number }>();
  const truncatedAccounts = new Set<string>();
  for (const result of input.results) {
    const parsed = calendarResult.safeParse(result.value);
    if (!parsed.success) { truncatedAccounts.add(result.account); continue; }
    for (const value of parsed.data.events) {
      const parsedEvent = calendarEvent.safeParse(value);
      if (!parsedEvent.success) { truncatedAccounts.add(result.account); continue; }
      const event = parsedEvent.data;
      if (event.status === "cancelled") continue;
      const start = event.start?.value ?? null;
      const end = event.end?.value ?? null;
      const allDay = event.start?.kind === "date" || event.start == null && event.end?.kind === "date";
      if (event.start == null || event.end == null) truncatedAccounts.add(result.account);
      if (allDay) {
        if (start !== null && start > input.date || end !== null && end <= input.date) continue;
      } else {
        const startDay = start === null ? null : pacificDate.format(Date.parse(start));
        const endDay = end === null ? null : pacificDate.format(Date.parse(end) - 1);
        if (startDay !== null && startDay > input.date || endDay !== null && endDay < input.date || endDay === null && startDay !== null && startDay !== input.date) continue;
      }
      // UID plus occurrence distinguishes recurring instances and proves identity across accounts.
      // Without UID the account/calendar/resource tuple is the only available identity evidence.
      const occurrence = start === null || allDay ? start : new Date(Date.parse(start)).toISOString();
      const identity = event.iCalUID == null || occurrence === null
        ? ["resource", result.account, event.calendar.label, event.eventId, occurrence]
        : ["ical", event.iCalUID, occurrence];
      const id = `calendar_${digest(JSON.stringify(identity))}`;
      const updated = event.updatedAt == null ? 0 : Date.parse(event.updatedAt);
      const previous = selected.get(id);
      if (previous === undefined || updated > previous.updated) selected.set(id, {
        event: { id, title: event.summary, start, end, allDay, location: event.location }, updated,
      });
    }
  }
  const calendar = [...selected.values()].map(({ event }) => event).sort((left, right) => {
    if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
    const leftTime = left.start === null ? Number.POSITIVE_INFINITY : Date.parse(left.start);
    const rightTime = right.start === null ? Number.POSITIVE_INFINITY : Date.parse(right.start);
    const delta = leftTime - rightTime;
    return (Number.isNaN(delta) ? 0 : delta) || left.id.localeCompare(right.id);
  });
  return { calendar, truncatedAccounts };
}

export interface PreviewLinkSource {
  id: string;
  toolName: string;
  value: unknown;
  verifiedEmail: string | null;
}

type TodoLink = PreviewArtifact["todos"][number]["links"][number];
const sourceItem = z.object({ id: z.string().min(1).max(2_048) });
const gmailItem = sourceItem.extend({ threadId: z.string().min(1).max(512).nullable().optional() });
const gmailThread = sourceItem.extend({ messages: z.array(gmailItem).max(50).optional() });
const gmailRead = z.object({ thread: gmailThread });
const gmailSearch = z.object({
  messages: z.array(gmailItem).max(20).optional(),
  hydration: z.object({ threads: z.array(z.object({ thread: gmailThread })).max(3) }).optional(),
});
const notionSearch = z.object({ result: z.object({
  results: z.array(sourceItem.partial()).max(100).optional(),
  pages: z.array(sourceItem.partial()).max(100).optional(),
}) });
const notionFetch = z.object({ result: sourceItem });
const verifiedEmail = z.string().email().max(320);

function gmailLink(email: string | null, id: string): TodoLink | null {
  if (email === null || !verifiedEmail.safeParse(email).success || !/^[a-f\d]{1,64}$/iu.test(id)) return null;
  return { url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${id}`, label: "Open email" };
}

function notionLink(id: string): TodoLink | null {
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/iu.test(id)) return null;
  return { url: `https://www.notion.so/${id.replaceAll("-", "").toLowerCase()}`, label: "Open Notion page" };
}

function linkCandidates(source: PreviewLinkSource): { items: Map<string, TodoLink | null>; direct: TodoLink | null } {
  const items = new Map<string, TodoLink | null>();
  let direct: TodoLink | null = null;
  if (source.toolName === "gmail.search") {
    const parsed = gmailSearch.safeParse(source.value);
    if (parsed.success) {
      for (const message of parsed.data.messages ?? []) {
        items.set(message.id, message.threadId == null ? null : gmailLink(source.verifiedEmail, message.threadId));
        if (message.threadId != null) items.set(message.threadId, gmailLink(source.verifiedEmail, message.threadId));
      }
      for (const { thread } of parsed.data.hydration?.threads ?? []) {
        items.set(thread.id, gmailLink(source.verifiedEmail, thread.id));
        for (const message of thread.messages ?? []) {
          if (message.threadId != null && message.threadId !== thread.id) continue;
          items.set(message.id, gmailLink(source.verifiedEmail, thread.id));
        }
      }
    }
  } else if (source.toolName === "gmail.read_thread") {
    const parsed = gmailRead.safeParse(source.value);
    if (parsed.success) {
      const thread = parsed.data.thread;
      direct = gmailLink(source.verifiedEmail, thread.id);
      items.set(thread.id, direct);
      for (const message of thread.messages ?? []) {
        if (message.threadId != null && message.threadId !== thread.id) continue;
        items.set(message.id, direct);
      }
    }
  } else if (source.toolName === "notion.search") {
    const parsed = notionSearch.safeParse(source.value);
    if (parsed.success) {
      for (const item of [...(parsed.data.result.results ?? []), ...(parsed.data.result.pages ?? [])]) {
        if (item.id !== undefined) items.set(item.id, notionLink(item.id));
      }
    }
  } else if (source.toolName === "notion.fetch") {
    const parsed = notionFetch.safeParse(source.value);
    if (parsed.success) {
      direct = notionLink(parsed.data.result.id);
      items.set(parsed.data.result.id, direct);
    }
  }
  return { items, direct };
}

// Resolve only exact normalized identities from persisted same-run reads. The model never supplies URLs.
export function projectPreviewTodos(input: {
  todos: z.infer<typeof previewDraftSchema>["todos"];
  sources: PreviewLinkSource[];
}): { kind: "valid"; todos: PreviewArtifact["todos"] } | { kind: "invalid"; code: "invalid_reference" } {
  const sources = new Map(input.sources.map((source) => [source.id, linkCandidates(source)]));
  const todos: PreviewArtifact["todos"] = [];
  for (const [index, todo] of input.todos.entries()) {
    const links = new Map<string, TodoLink>();
    for (const reference of todo.references) {
      const source = sources.get(reference.sourceId);
      if (!todo.sourceIds.includes(reference.sourceId) || source === undefined || !source.items.has(reference.itemId)) {
        return { kind: "invalid", code: "invalid_reference" };
      }
      const link = source.items.get(reference.itemId);
      if (link != null) links.set(link.url, link);
    }
    for (const sourceId of todo.sourceIds) {
      const link = sources.get(sourceId)?.direct;
      if (link != null) links.set(link.url, link);
    }
    const { references: _references, ...content } = todo;
    todos.push({
      id: `todo_${digest(JSON.stringify({ index, ...todo }))}`, ...content,
      links: [...links.values()].sort((left, right) => Number(right.label === "Open email") - Number(left.label === "Open email")).slice(0, 32),
    });
  }
  return { kind: "valid", todos };
}
