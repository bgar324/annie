import { convert } from "html-to-text";
import { z } from "zod";

const pageTokenSchema = z.string().min(1).nullish();
const calendarSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().nullish(),
    description: z.string().nullish(),
    primary: z.boolean().nullish(),
    accessRole: z.string().nullish(),
    timeZone: z.string().nullish(),
  })
  .loose();
const calendarListSchema = z
  .object({
    items: z.array(calendarSchema).nullish(),
    nextPageToken: pageTokenSchema,
  })
  .loose();
const eventTimeSchema = z
  .object({
    date: z.string().nullish(),
    dateTime: z.string().nullish(),
    timeZone: z.string().nullish(),
  })
  .loose()
  .refine((value) => value.date !== undefined && value.date !== null || value.dateTime !== undefined && value.dateTime !== null);
const attendeeSchema = z
  .object({
    email: z.string().nullish(),
    displayName: z.string().nullish(),
    responseStatus: z.string().nullish(),
    organizer: z.boolean().nullish(),
    optional: z.boolean().nullish(),
  })
  .loose();
const eventSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().nullish(),
    summary: z.string().nullish(),
    description: z.string().nullish(),
    location: z.string().nullish(),
    htmlLink: z.string().nullish(),
    hangoutLink: z.string().nullish(),
    start: eventTimeSchema,
    end: eventTimeSchema,
    attendees: z.array(attendeeSchema).nullish(),
    attendeesOmitted: z.boolean().nullish(),
    recurrence: z.array(z.string()).nullish(),
    recurringEventId: z.string().nullish(),
    updated: z.string().nullish(),
  })
  .loose();
const eventListSchema = z
  .object({
    items: z.array(eventSchema).nullish(),
    nextPageToken: pageTokenSchema,
  })
  .loose();

const driveFileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullish(),
    mimeType: z.string().nullish(),
    modifiedTime: z.string().nullish(),
    createdTime: z.string().nullish(),
    size: z.string().nullish(),
    capabilities: z.object({ canDownload: z.boolean().nullish() }).loose().nullish(),
    clientEncryptionDetails: z
      .object({ encryptionState: z.enum(["encrypted", "unencrypted"]).nullish() })
      .loose()
      .nullish(),
  })
  .loose();
const driveListSchema = z
  .object({
    files: z.array(driveFileSchema).nullish(),
    nextPageToken: pageTokenSchema,
    incompleteSearch: z.boolean().nullish(),
  })
  .loose();
const driveTextSchema = z
  .object({
    content: z.string(),
    truncated: z.boolean(),
  })
  .strict();

const personDateSchema = z
  .object({
    year: z.number().int().nullish(),
    month: z.number().int().min(1).max(12).nullish(),
    day: z.number().int().min(1).max(31).nullish(),
  })
  .loose();
const personSchema = z
  .object({
    resourceName: z.string().min(1),
    names: z.array(z.object({ displayName: z.string().nullish() }).loose()).nullish(),
    emailAddresses: z
      .array(z.object({ value: z.string().nullish(), type: z.string().nullish() }).loose())
      .nullish(),
    phoneNumbers: z
      .array(z.object({ value: z.string().nullish(), type: z.string().nullish() }).loose())
      .nullish(),
    organizations: z
      .array(
        z
          .object({
            name: z.string().nullish(),
            title: z.string().nullish(),
            department: z.string().nullish(),
          })
          .loose(),
      )
      .nullish(),
    addresses: z
      .array(z.object({ formattedValue: z.string().nullish(), type: z.string().nullish() }).loose())
      .nullish(),
    birthdays: z.array(z.object({ date: personDateSchema.nullish() }).loose()).nullish(),
    biographies: z
      .array(z.object({ value: z.string().nullish(), contentType: z.string().nullish() }).loose())
      .nullish(),
    nicknames: z
      .array(z.object({ value: z.string().nullish(), type: z.string().nullish() }).loose())
      .nullish(),
    relations: z
      .array(z.object({ person: z.string().nullish(), type: z.string().nullish() }).loose())
      .nullish(),
  })
  .loose();
const contactSearchSchema = z
  .object({
    results: z.array(z.object({ person: personSchema.nullish() }).loose()).nullish(),
    nextPageToken: pageTokenSchema,
  })
  .loose();

const taskListSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullish(),
    updated: z.string().nullish(),
  })
  .loose();
const taskListsSchema = z
  .object({
    items: z.array(taskListSchema).nullish(),
    nextPageToken: pageTokenSchema,
  })
  .loose();
const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullish(),
    notes: z.string().nullish(),
    status: z.string().nullish(),
    due: z.string().nullish(),
    completed: z.string().nullish(),
    updated: z.string().nullish(),
    parent: z.string().nullish(),
    position: z.string().nullish(),
  })
  .loose();
const tasksSchema = z
  .object({
    items: z.array(taskSchema).nullish(),
    nextPageToken: pageTokenSchema,
  })
  .loose();

export interface CalendarResource {
  id: string;
  label: string;
  description: string | null;
  primary: boolean;
  accessRole: string | null;
  timeZone: string | null;
}

export interface NormalizedCalendarEvent {
  eventId: string;
  calendar: { label: string; primary: boolean };
  status: string | null;
  summary: string;
  description: string;
  location: string | null;
  webUrl: string | null;
  meetingUrl: string | null;
  start: NormalizedEventTime;
  end: NormalizedEventTime;
  attendees: readonly {
    email: string | null;
    displayName: string | null;
    responseStatus: string | null;
    organizer: boolean;
    optional: boolean;
  }[];
  attendeesTruncated: boolean;
  recurrence: readonly string[];
  recurringEventId: string | null;
  updatedAt: string | null;
}

export type NormalizedEventTime =
  | { kind: "date"; value: string }
  | { kind: "dateTime"; value: string; timeZone: string | null };

export interface NormalizedDriveFile {
  fileId: string;
  name: string;
  mimeType: string;
  modifiedAt: string | null;
  createdAt: string | null;
  sizeBytes: string | null;
  canDownload: boolean | null;
  clientSideEncrypted: boolean;
}

export interface NormalizedContact {
  contactId: string;
  displayName: string;
  emailAddresses: readonly { value: string; type: string | null }[];
  phoneNumbers: readonly { value: string; type: string | null }[];
  organizations: readonly { name: string; title: string | null; department: string | null }[];
  addresses: readonly { formatted: string; type: string | null }[];
  birthdays: readonly { year: number | null; month: number | null; day: number | null }[];
  biographies: readonly { value: string; contentType: "TEXT_PLAIN" }[];
  nicknames: readonly { value: string; type: string | null }[];
  relations: readonly { person: string; type: string | null }[];
}

export interface NormalizedTaskList {
  taskListId: string;
  title: string;
  updatedAt: string | null;
}

export interface NormalizedTask {
  taskId: string;
  taskList: { taskListId: string; title: string };
  title: string;
  notes: string;
  status: string | null;
  dueDate: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  parentTaskId: string | null;
  position: string | null;
}

export function parseCalendarList(data: unknown): {
  calendars: readonly CalendarResource[];
  nextPageToken: string | null;
} {
  const parsed = calendarListSchema.parse(data);
  return {
    calendars: (parsed.items ?? []).map((calendar) => ({
      id: calendar.id,
      label: truncateUtf8(calendar.summary ?? "Untitled calendar", 256).value,
      description: nullableTruncated(calendar.description, 1_024),
      primary: calendar.primary ?? false,
      accessRole: calendar.accessRole ?? null,
      timeZone: calendar.timeZone ?? null,
    })),
    nextPageToken: parsed.nextPageToken ?? null,
  };
}

export function parseCalendarEvents(
  data: unknown,
  calendar: CalendarResource,
): { events: readonly NormalizedCalendarEvent[]; nextPageToken: string | null } {
  const parsed = eventListSchema.parse(data);
  return {
    events: (parsed.items ?? []).map((event) => {
      const attendees = (event.attendees ?? []).slice(0, 20);
      return {
        eventId: event.id,
        calendar: { label: calendar.label, primary: calendar.primary },
        status: event.status ?? null,
        summary: truncateUtf8(event.summary ?? "(No title)", 512).value,
        description: truncateUtf8(event.description ?? "", 2_048).value,
        location: nullableTruncated(event.location, 512),
        webUrl: event.htmlLink ?? null,
        meetingUrl: event.hangoutLink ?? null,
        start: normalizeEventTime(event.start),
        end: normalizeEventTime(event.end),
        attendees: attendees.map((attendee) => ({
          email: nullableTruncated(attendee.email, 320),
          displayName: nullableTruncated(attendee.displayName, 256),
          responseStatus: attendee.responseStatus ?? null,
          organizer: attendee.organizer ?? false,
          optional: attendee.optional ?? false,
        })),
        attendeesTruncated: event.attendeesOmitted === true || (event.attendees?.length ?? 0) > attendees.length,
        recurrence: (event.recurrence ?? []).slice(0, 10).map((value) => truncateUtf8(value, 512).value),
        recurringEventId: event.recurringEventId ?? null,
        updatedAt: event.updated ?? null,
      };
    }),
    nextPageToken: parsed.nextPageToken ?? null,
  };
}

export function parseDriveFileList(data: unknown): {
  files: readonly NormalizedDriveFile[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
} {
  const parsed = driveListSchema.parse(data);
  return {
    files: (parsed.files ?? []).map(normalizeDriveFile),
    nextPageToken: parsed.nextPageToken ?? null,
    incompleteSearch: parsed.incompleteSearch ?? false,
  };
}

export function parseDriveFile(data: unknown): NormalizedDriveFile {
  return normalizeDriveFile(driveFileSchema.parse(data));
}

export function parseDriveText(data: unknown): { content: string; truncated: boolean } {
  return driveTextSchema.parse(data);
}

export function parseContactSearch(data: unknown): {
  contacts: readonly NormalizedContact[];
  nextPageToken: string | null;
} {
  const parsed = contactSearchSchema.parse(data);
  return {
    contacts: (parsed.results ?? [])
      .flatMap((result) => result.person === undefined || result.person === null ? [] : [normalizeContact(result.person)]),
    nextPageToken: parsed.nextPageToken ?? null,
  };
}

export function parseContact(data: unknown): NormalizedContact {
  return normalizeContact(personSchema.parse(data));
}

export function parseTaskLists(data: unknown): {
  taskLists: readonly NormalizedTaskList[];
  nextPageToken: string | null;
} {
  const parsed = taskListsSchema.parse(data);
  return {
    taskLists: (parsed.items ?? []).map((taskList) => ({
      taskListId: taskList.id,
      title: truncateUtf8(taskList.title ?? "Untitled task list", 256).value,
      updatedAt: taskList.updated ?? null,
    })),
    nextPageToken: parsed.nextPageToken ?? null,
  };
}

export function parseTasks(
  data: unknown,
  taskList: NormalizedTaskList,
): { tasks: readonly NormalizedTask[]; nextPageToken: string | null } {
  const parsed = tasksSchema.parse(data);
  return {
    tasks: (parsed.items ?? []).map((task) => normalizeTask(task, taskList)),
    nextPageToken: parsed.nextPageToken ?? null,
  };
}

export function parseTask(data: unknown, taskList: NormalizedTaskList): NormalizedTask {
  return normalizeTask(taskSchema.parse(data), taskList);
}

function normalizeDriveFile(file: z.infer<typeof driveFileSchema>): NormalizedDriveFile {
  return {
    fileId: file.id,
    name: truncateUtf8(file.name ?? "Untitled file", 512).value,
    mimeType: file.mimeType ?? "application/octet-stream",
    modifiedAt: file.modifiedTime ?? null,
    createdAt: file.createdTime ?? null,
    sizeBytes: file.size !== undefined && file.size !== null && /^\d+$/u.test(file.size)
      ? file.size
      : null,
    canDownload: file.capabilities?.canDownload ?? null,
    clientSideEncrypted: file.clientEncryptionDetails?.encryptionState === "encrypted",
  };
}

function normalizeContact(person: z.infer<typeof personSchema>): NormalizedContact {
  return {
    contactId: person.resourceName,
    displayName: truncateUtf8(person.names?.[0]?.displayName ?? "Unnamed contact", 256).value,
    emailAddresses: compactTypedValues(person.emailAddresses, 320),
    phoneNumbers: compactTypedValues(person.phoneNumbers, 128),
    organizations: (person.organizations ?? [])
      .flatMap((organization) => organization.name === undefined || organization.name === null ? [] : [{
        name: truncateUtf8(organization.name, 256).value,
        title: nullableTruncated(organization.title, 256),
        department: nullableTruncated(organization.department, 256),
      }])
      .slice(0, 10),
    addresses: (person.addresses ?? [])
      .flatMap((address) => address.formattedValue === undefined || address.formattedValue === null ? [] : [{
        formatted: truncateUtf8(address.formattedValue, 1_024).value,
        type: address.type ?? null,
      }])
      .slice(0, 10),
    birthdays: (person.birthdays ?? []).flatMap((birthday) => birthday.date === undefined || birthday.date === null ? [] : [{
      year: birthday.date.year ?? null,
      month: birthday.date.month ?? null,
      day: birthday.date.day ?? null,
    }]).slice(0, 10),
    biographies: (person.biographies ?? [])
      .flatMap((biography) => biography.value === undefined || biography.value === null ? [] : [{
        value: truncateUtf8(
          biography.contentType === "TEXT_HTML" ? htmlToPlainText(biography.value) : biography.value,
          2_048,
        ).value,
        contentType: "TEXT_PLAIN" as const,
      }])
      .slice(0, 5),
    nicknames: compactTypedValues(person.nicknames, 256),
    relations: (person.relations ?? [])
      .flatMap((relation) => relation.person === undefined || relation.person === null ? [] : [{
        person: truncateUtf8(relation.person, 256).value,
        type: relation.type ?? null,
      }])
      .slice(0, 10),
  };
}

function normalizeTask(
  task: z.infer<typeof taskSchema>,
  taskList: NormalizedTaskList,
): NormalizedTask {
  return {
    taskId: task.id,
    taskList: { taskListId: taskList.taskListId, title: taskList.title },
    title: truncateUtf8(task.title ?? "Untitled task", 512).value,
    notes: truncateUtf8(task.notes ?? "", 2_048).value,
    status: task.status ?? null,
    dueDate: task.due?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0] ?? null,
    completedAt: task.completed ?? null,
    updatedAt: task.updated ?? null,
    parentTaskId: task.parent ?? null,
    position: task.position ?? null,
  };
}
function htmlToPlainText(value: string): string {
  return convert(value, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  });
}


function normalizeEventTime(value: z.infer<typeof eventTimeSchema>): NormalizedEventTime {
  if (value.dateTime !== undefined && value.dateTime !== null) {
    return { kind: "dateTime", value: value.dateTime, timeZone: value.timeZone ?? null };
  }
  return { kind: "date", value: value.date! };
}

function compactTypedValues(
  values: readonly { value?: string | null | undefined; type?: string | null | undefined }[] | null | undefined,
  maximumBytes: number,
): readonly { value: string; type: string | null }[] {
  return (values ?? [])
    .flatMap((value) => value.value === undefined || value.value === null ? [] : [{
      value: truncateUtf8(value.value, maximumBytes).value,
      type: value.type ?? null,
    }])
    .slice(0, 10);
}

function nullableTruncated(value: string | null | undefined, maximumBytes: number): string | null {
  return value === undefined || value === null ? null : truncateUtf8(value, maximumBytes).value;
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) {
    return { value, truncated: false };
  }
  let end = maximumBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}
