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
  }).strict()).max(20),
}).strict();
export const previewOutputSchema = {
  type: "object", additionalProperties: false, required: ["todos"],
  properties: { todos: { type: "array", maxItems: 20, items: {
    type: "object", additionalProperties: false, required: ["title", "detail", "due", "sourceIds"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      detail: { type: ["string", "null"], maxLength: 2048 },
      due: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "string", format: "date-time" }, { type: "null" }] },
      sourceIds: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 } },
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
  todos: (z.infer<typeof previewDraftSchema>["todos"][number] & { id: string })[];
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
