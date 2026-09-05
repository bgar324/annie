import { z } from "zod";
import type { AgentRunStore } from "../agent/store.js";
import { parseToolArguments, type RegisteredTool, type ToolExecutionContext } from "../agent/tools.js";
import type { ConnectionRouter } from "../connections/router.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionCapability, ConnectionRecord } from "../connections/types.js";
import { ModelSafeError } from "../core/errors.js";
import type { TraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";
import type {
  GoogleProviderResponse,
  GoogleWorkspaceApi,
  GoogleWorkspaceClientProvider,
} from "./client.js";
import {
  parseCalendarEvents,
  parseCalendarList,
  parseContact,
  parseContactSearch,
  parseDriveFile,
  parseDriveFileList,
  parseDriveText,
  parseTask,
  parseTaskLists,
  parseTasks,
  type CalendarResource,
  type NormalizedCalendarEvent,
  type NormalizedTask,
  type NormalizedTaskList,
} from "./normalize.js";

const accountSchema = z.string().trim().min(1).max(160).optional();
const rfc3339Schema = z
  .string()
  .min(1)
  .max(64)
  .refine(isRfc3339DateTime, "Must be an RFC 3339 date-time with Z or an explicit offset");
const calendarQuerySchema = z
  .object({
    product: z.literal("calendar"),
    timeMin: rfc3339Schema,
    timeMax: rfc3339Schema,
    query: z.string().trim().min(1).max(256).optional(),
    maxResults: z.number().int().min(1).max(20).default(10),
  })
  .strict()
  .refine((value) => Date.parse(value.timeMin) < Date.parse(value.timeMax), {
    message: "timeMin must be before timeMax",
  });
const driveQuerySchema = z
  .object({
    product: z.literal("drive"),
    text: z.string().trim().min(1).max(200).optional(),
    modifiedAfter: rfc3339Schema.optional(),
    modifiedBefore: rfc3339Schema.optional(),
    maxResults: z.number().int().min(1).max(20).default(10),
  })
  .strict()
  .refine(
    (value) => value.modifiedAfter === undefined || value.modifiedBefore === undefined || Date.parse(value.modifiedAfter) < Date.parse(value.modifiedBefore),
    { message: "modifiedAfter must be before modifiedBefore" },
  );
const contactsQuerySchema = z
  .object({
    product: z.literal("contacts"),
    query: z.string().trim().min(1).max(200),
    maxResults: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const tasksQuerySchema = z
  .object({
    product: z.literal("tasks"),
    query: z.string().trim().min(1).max(200).optional(),
    dueBefore: rfc3339Schema.optional(),
    includeCompleted: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const productQuerySchema = z.discriminatedUnion("product", [
  calendarQuerySchema,
  driveQuerySchema,
  contactsQuerySchema,
  tasksQuerySchema,
]);
const searchArgumentsSchema = z
  .object({
    account: accountSchema,
    queries: z.array(productQuerySchema).min(1).max(4),
  })
  .strict()
  .superRefine((value, context) => {
    const products = new Set<string>();
    for (const [index, query] of value.queries.entries()) {
      if (products.has(query.product)) {
        context.addIssue({
          code: "custom",
          path: ["queries", index, "product"],
          message: `Duplicate ${query.product} query`,
        });
      }
      products.add(query.product);
    }
  });
const driveReadSchema = z
  .object({
    product: z.literal("drive"),
    fileId: z.string().min(1).max(512),
    account: accountSchema,
  })
  .strict();
const contactReadSchema = z
  .object({
    product: z.literal("contacts"),
    contactId: z.string().min(1).max(512),
    account: accountSchema,
  })
  .strict();
const taskReadSchema = z
  .object({
    product: z.literal("tasks"),
    taskListId: z.string().min(1).max(512),
    taskId: z.string().min(1).max(512),
    account: accountSchema,
  })
  .strict();
const readArgumentsSchema = z.discriminatedUnion("product", [
  driveReadSchema,
  contactReadSchema,
  taskReadSchema,
]);

type ProductQuery = z.infer<typeof productQuerySchema>;
type ReadArguments = z.infer<typeof readArgumentsSchema>;
type QueryProduct = ProductQuery["product"];
const maximumCalendars = 20;
const maximumCalendarAttendees = 20;
const maximumTaskLists = 10;
const productResultBudgetBytes = 28 * 1_024;

export class GoogleWorkspaceToolService {
  readonly #router: ConnectionRouter;
  readonly #connections: ConnectionStore;
  readonly #clients: GoogleWorkspaceClientProvider;
  readonly #runs: AgentRunStore;
  readonly #traces: TraceStore;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    router: ConnectionRouter;
    connections: ConnectionStore;
    clients: GoogleWorkspaceClientProvider;
    runs: AgentRunStore;
    traces: TraceStore;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#router = input.router;
    this.#connections = input.connections;
    this.#clients = input.clients;
    this.#runs = input.runs;
    this.#traces = input.traces;
    this.#sleep = input.sleep ?? delay;
  }

  tools(): readonly RegisteredTool[] {
    return [
      {
        definition: {
          name: "google.search",
          description: "Run one bounded read-only search batch against Calendar, Drive, Contacts, or Tasks in one connected Google account. For automatic multi-account reads, call once per exact safe label in connected account status. Each product may appear once.",
          parameters: searchJsonSchema,
        },
        operationClass: "read",
        batchMode: "parallel_read",
        execute: async (argumentsValue, context) =>
          this.search(parseToolArguments(searchArgumentsSchema, argumentsValue), context),
      },
      {
        definition: {
          name: "google.read",
          description: "Read one Drive file, Google contact, or Google task from the source account returned by google.search.",
          parameters: readJsonSchema,
        },
        operationClass: "read",
        batchMode: "parallel_read",
        execute: async (argumentsValue, context) =>
          this.read(parseToolArguments(readArgumentsSchema, argumentsValue), context),
      },
    ];
  }

  async search(
    input: z.infer<typeof searchArgumentsSchema>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const capabilities = requiredCapabilities(input.queries);
    const selected = this.#select(capabilities, input.account, context);
    const api = await this.#clients.forConnection(selected.id, context.traceId, context.signal);
    const connection = this.#router.select({
      capabilities,
      connectionId: selected.id,
    });
    const results = await Promise.all(
      input.queries.map(async (query) => {
        try {
          return await this.#searchProduct(query, api, connection, context);
        } catch (error) {
          if (context.signal?.aborted === true) {
            throw context.signal.reason ?? error;
          }
          return productFailure(query.product, error);
        }
      }),
    );
    if (results.every((result) => result.ok)) {
      this.#markHealthy(connection, context.traceId);
    }
    return {
      account: { label: connection.safeLabel },
      results,
    };
  }

  async read(input: ReadArguments, context: ToolExecutionContext): Promise<unknown> {
    const capabilities = [capabilityForProduct(input.product)] as const;
    const selected = this.#select(capabilities, input.account, context);
    const api = await this.#clients.forConnection(selected.id, context.traceId, context.signal);
    const connection = this.#router.select({ capabilities, connectionId: selected.id });
    const result = await this.#readProduct(input, api, connection, context);
    this.#markHealthy(connection, context.traceId);
    return {
      account: { label: connection.safeLabel },
      ...result,
    };
  }

  async #searchProduct(
    query: ProductQuery,
    api: GoogleWorkspaceApi,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): Promise<Record<string, unknown> & { product: QueryProduct; ok: true }> {
    switch (query.product) {
      case "calendar":
        return this.#searchCalendar(query, api, connection, context);
      case "drive":
        return this.#searchDrive(query, api, connection, context);
      case "contacts":
        return this.#searchContacts(query, api, connection, context);
      case "tasks":
        return this.#searchTasks(query, api, connection, context);
    }
  }

  async #searchCalendar(
    query: z.infer<typeof calendarQuerySchema>,
    api: GoogleWorkspaceApi,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): Promise<Record<string, unknown> & { product: "calendar"; ok: true }> {
    const calendars: CalendarResource[] = [];
    let pageToken: string | null = null;
    let page = 0;
    do {
      const response = await this.#readRequest("calendar.calendarList.list", connection, context, () =>
        api.listCalendars({
          maxResults: maximumCalendars - calendars.length,
          ...(pageToken === null ? {} : { pageToken }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
      const parsed = parseCalendarList(response.data);
      calendars.push(...parsed.calendars.slice(0, maximumCalendars - calendars.length));
      pageToken = parsed.nextPageToken;
      page += 1;
    } while (pageToken !== null && calendars.length < maximumCalendars && page < 4);

    const calendarResults = await Promise.all(
      calendars.map(async (calendar) => {
        try {
          const response = await this.#readRequest("calendar.events.list", connection, context, () =>
            api.listEvents({
              calendarId: calendar.id,
              timeMin: query.timeMin,
              timeMax: query.timeMax,
              maxResults: query.maxResults,
              maxAttendees: maximumCalendarAttendees,
              ...(query.query === undefined ? {} : { query: query.query }),
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          );
          const parsed = parseCalendarEvents(response.data, calendar);
          return { ok: true as const, events: parsed.events, truncated: parsed.nextPageToken !== null };
        } catch (error) {
          if (context.signal?.aborted === true) {
            throw context.signal.reason ?? error;
          }
          return { ok: false as const, calendar: calendar.label };
        }
      }),
    );
    const allEvents = calendarResults
      .flatMap((result) => result.ok ? result.events : [])
      .sort(compareCalendarEvents);
    const bounded = boundItems(allEvents, query.maxResults, productResultBudgetBytes);
    const failedCalendars = calendarResults.flatMap((result) => result.ok ? [] : [result.calendar]);
    return {
      product: "calendar",
      ok: true,
      calendarsSearched: calendars.map((calendar) => ({
        label: calendar.label,
        primary: calendar.primary,
      })),
      events: bounded.items,
      truncated:
        bounded.truncated ||
        pageToken !== null ||
        calendarResults.some((result) => result.ok && result.truncated),
      incomplete: pageToken !== null || failedCalendars.length > 0,
      failedCalendars,
    };
  }

  async #searchDrive(
    query: z.infer<typeof driveQuerySchema>,
    api: GoogleWorkspaceApi,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): Promise<Record<string, unknown> & { product: "drive"; ok: true }> {
    const response = await this.#readRequest("drive.files.list", connection, context, () =>
      api.listDriveFiles({
        query: driveSearchQuery(query),
        orderByModifiedTime: query.text === undefined,
        maxResults: query.maxResults,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
    const parsed = parseDriveFileList(response.data);
    const bounded = boundItems(parsed.files, query.maxResults, productResultBudgetBytes);
    return {
      product: "drive",
      ok: true,
      files: bounded.items,
      truncated: bounded.truncated || parsed.nextPageToken !== null,
      incomplete: parsed.incompleteSearch,
    };
  }

  async #searchContacts(
    query: z.infer<typeof contactsQuerySchema>,
    api: GoogleWorkspaceApi,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): Promise<Record<string, unknown> & { product: "contacts"; ok: true }> {
    const warmed = await this.#readRequest("people.searchContacts.warm", connection, context, () =>
      api.warmContacts(context.signal === undefined ? {} : { signal: context.signal }),
    );
    parseContactSearch(warmed.data);
    const response = await this.#readRequest("people.searchContacts", connection, context, () =>
      api.searchContacts({
        query: query.query,
        maxResults: query.maxResults,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
    const parsed = parseContactSearch(response.data);
    const bounded = boundItems(parsed.contacts, query.maxResults, productResultBudgetBytes);
    return {
      product: "contacts",
      ok: true,
      contacts: bounded.items,
      truncated: bounded.truncated || parsed.nextPageToken !== null,
    };
  }

  async #searchTasks(
    query: z.infer<typeof tasksQuerySchema>,
    api: GoogleWorkspaceApi,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): Promise<Record<string, unknown> & { product: "tasks"; ok: true }> {
    const taskLists: NormalizedTaskList[] = [];
    let pageToken: string | null = null;
    let page = 0;
    do {
      const response = await this.#readRequest("tasks.tasklists.list", connection, context, () =>
        api.listTaskLists({
          maxResults: maximumTaskLists - taskLists.length,
          ...(pageToken === null ? {} : { pageToken }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
      const parsed = parseTaskLists(response.data);
      taskLists.push(...parsed.taskLists.slice(0, maximumTaskLists - taskLists.length));
      pageToken = parsed.nextPageToken;
      page += 1;
    } while (pageToken !== null && taskLists.length < maximumTaskLists && page < 4);

    const taskListResults = await Promise.all(
      taskLists.map(async (taskList) => {
        try {
          const response = await this.#readRequest("tasks.tasks.list", connection, context, () =>
            api.listTasks({
              taskListId: taskList.taskListId,
              maxResults: query.query === undefined ? query.maxResults : 50,
              includeCompleted: query.includeCompleted,
              ...(query.dueBefore === undefined ? {} : { dueBefore: query.dueBefore }),
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          );
          const parsed = parseTasks(response.data, taskList);
          return { ok: true as const, tasks: parsed.tasks, truncated: parsed.nextPageToken !== null };
        } catch (error) {
          if (context.signal?.aborted === true) {
            throw context.signal.reason ?? error;
          }
          return { ok: false as const, taskList: taskList.title };
        }
      }),
    );
    const needle = query.query?.toLocaleLowerCase();
    const filtered = taskListResults
      .flatMap((result) => result.ok ? result.tasks : [])
      .filter((task) => needle === undefined || `${task.title}\n${task.notes}`.toLocaleLowerCase().includes(needle))
      .sort(compareTasks);
    const bounded = boundItems(filtered, query.maxResults, productResultBudgetBytes);
    const failedTaskLists = taskListResults.flatMap((result) => result.ok ? [] : [result.taskList]);
    return {
      product: "tasks",
      ok: true,
      taskListsSearched: taskLists.map((taskList) => ({ title: taskList.title })),
      tasks: bounded.items,
      truncated:
        bounded.truncated ||
        pageToken !== null ||
        taskListResults.some((result) => result.ok && result.truncated),
      incomplete: pageToken !== null || failedTaskLists.length > 0,
      failedTaskLists,
    };
  }

  async #readProduct(
    input: ReadArguments,
    api: GoogleWorkspaceApi,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    switch (input.product) {
      case "drive": {
        const metadataResponse = await this.#readRequest("drive.files.get", connection, context, () =>
          api.getDriveFile({
            fileId: input.fileId,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          }),
        );
        const file = parseDriveFile(metadataResponse.data);
        if (file.clientSideEncrypted) {
          return {
            product: "drive",
            file,
            contentUnavailable: "This file is client-side encrypted",
          };
        }
        if (file.canDownload === false) {
          return {
            product: "drive",
            file,
            contentUnavailable: "Downloading this file is restricted",
          };
        }
        const exportMimeType = driveExportMimeType(file.mimeType);
        if (exportMimeType !== null) {
          const contentResponse = await this.#readRequest("drive.files.export", connection, context, () =>
            api.exportDriveText({
              fileId: input.fileId,
              mimeType: exportMimeType,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          );
          return {
            product: "drive",
            file,
            content: {
              ...parseDriveText(contentResponse.data),
              mimeType: exportMimeType,
              warnings: driveContentWarnings(file.mimeType),
            },
          };
        }
        if (isTextMimeType(file.mimeType)) {
          const contentResponse = await this.#readRequest("drive.files.get.media", connection, context, () =>
            api.downloadDriveText({
              fileId: input.fileId,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          );
          return {
            product: "drive",
            file,
            content: { ...parseDriveText(contentResponse.data), mimeType: file.mimeType },
          };
        }
        return {
          product: "drive",
          file,
          contentUnavailable: "This file is not a supported text or Google Workspace document",
        };
      }
      case "contacts": {
        const response = await this.#readRequest("people.people.get", connection, context, () =>
          api.getContact({
            contactId: input.contactId,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          }),
        );
        return { product: "contacts", contact: parseContact(response.data) };
      }
      case "tasks": {
        const [taskListResponse, taskResponse] = await Promise.all([
          this.#readRequest("tasks.tasklists.get", connection, context, () =>
            api.getTaskList({
              taskListId: input.taskListId,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          ),
          this.#readRequest("tasks.tasks.get", connection, context, () =>
            api.getTask({
              taskListId: input.taskListId,
              taskId: input.taskId,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          ),
        ]);
        const taskList = parseTaskLists({ items: [taskListResponse.data] }).taskLists[0];
        if (taskList === undefined) {
          throw new GoogleWorkspaceToolError("provider_response_invalid", "Google Tasks returned no task list");
        }
        return { product: "tasks", task: parseTask(taskResponse.data, taskList) };
      }
    }
  }


  #select(
    capabilities: readonly [ConnectionCapability, ...ConnectionCapability[]],
    account: string | undefined,
    context: ToolExecutionContext,
  ): ConnectionRecord {
    const connection = this.#router.select({
      capabilities,
      ...(context.connectionId === null
        ? account === undefined
          ? {}
          : { account }
        : { connectionId: context.connectionId }),
    });
    this.#runs.bindToolConnection(context.toolExecutionId, connection.id);
    return connection;
  }

  async #readRequest(
    operation: string,
    connection: ConnectionRecord,
    context: ToolExecutionContext,
    request: () => Promise<GoogleProviderResponse>,
  ): Promise<GoogleProviderResponse> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.#traceRequest(context.traceId, operation, connection, "attempted", { attempt });
      try {
        const response = await request();
        this.#traceRequest(context.traceId, operation, connection, "succeeded", {
          attempt,
          providerRequestId: providerRequestId(response.headers),
        });
        return response;
      } catch (error) {
        if (context.signal?.aborted === true) {
          throw context.signal.reason ?? error;
        }
        const status = providerStatus(error);
        const retryable = status === null || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
        const retryAfterMs = retryable ? googleRetryDelay(error, attempt) : null;
        this.#traceRequest(context.traceId, operation, connection, "failed", {
          attempt,
          status,
          retryable,
          retryAfterMs,
        });
        if (retryable && attempt < 3) {
          await raceAbort(this.#sleep(retryAfterMs ?? attempt * 250), context.signal);
          continue;
        }
        throw new GoogleWorkspaceToolError(
          status === 429 ? "rate_limited" : "provider_read_failed",
          `Google ${operation} failed${status === null ? "" : ` with HTTP ${status}`}`,
          { cause: error },
        );
      }
    }
    throw new Error("Unreachable Google read retry state");
  }

  #markHealthy(connection: ConnectionRecord, traceId: TraceId): void {
    this.#connections.markHealthy({
      connectionId: connection.id,
      credentialGeneration: connection.credentialGeneration,
      traceId,
    });
  }

  #traceRequest(
    traceId: TraceId,
    operation: string,
    connection: ConnectionRecord,
    event: "attempted" | "succeeded" | "failed",
    data: Record<string, unknown>,
  ): void {
    this.#traces.append({
      traceId,
      component: "google",
      event: `request_${event}`,
      outcome: operation,
      ...(typeof data.providerRequestId === "string"
        ? { providerRequestId: data.providerRequestId }
        : {}),
      data: {
        operation,
        connectionId: connection.id,
        credentialGeneration: connection.credentialGeneration,
        ...data,
      },
    });
  }
}

type GoogleWorkspaceToolErrorCode =
  | "rate_limited"
  | "provider_read_failed"
  | "provider_response_invalid";

export class GoogleWorkspaceToolError extends ModelSafeError<GoogleWorkspaceToolErrorCode> {
  constructor(code: GoogleWorkspaceToolErrorCode, message: string, options?: ErrorOptions) {
    super("GoogleWorkspaceToolError", code, message, options);
  }
}


function requiredCapabilities(
  queries: readonly [ProductQuery, ...ProductQuery[]] | readonly ProductQuery[],
): [ConnectionCapability, ...ConnectionCapability[]] {
  const first = queries[0];
  if (first === undefined) {
    throw new TypeError("A Google search batch requires at least one query");
  }
  return [capabilityForProduct(first.product), ...queries.slice(1).map((query) => capabilityForProduct(query.product))];
}

function capabilityForProduct(product: QueryProduct): ConnectionCapability {
  switch (product) {
    case "calendar":
      return "calendar.read";
    case "drive":
      return "drive.read";
    case "contacts":
      return "contacts.read";
    case "tasks":
      return "tasks.read";
  }
}

function driveSearchQuery(input: z.infer<typeof driveQuerySchema>): string {
  const clauses = ["trashed = false"];
  if (input.text !== undefined) {
    const text = escapeDriveQueryLiteral(input.text);
    clauses.push(`(name contains '${text}' or fullText contains '${text}')`);
  }
  if (input.modifiedAfter !== undefined) {
    clauses.push(`modifiedTime >= '${escapeDriveQueryLiteral(input.modifiedAfter)}'`);
  }
  if (input.modifiedBefore !== undefined) {
    clauses.push(`modifiedTime < '${escapeDriveQueryLiteral(input.modifiedBefore)}'`);
  }
  return clauses.join(" and ");
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function driveExportMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    default:
      return null;
  }
}

function isRfc3339DateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return (
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/rtf",
  ].includes(mimeType);
}

function driveContentWarnings(mimeType: string): readonly string[] {
  return mimeType === "application/vnd.google-apps.spreadsheet"
    ? ["CSV export contains only the first sheet"]
    : [];
}

function productFailure(product: QueryProduct, error: unknown): {
  product: QueryProduct;
  ok: false;
  error: { code: GoogleWorkspaceToolErrorCode; message: string };
} {
  if (error instanceof GoogleWorkspaceToolError) {
    return { product, ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof z.ZodError) {
    return {
      product,
      ok: false,
      error: { code: "provider_response_invalid", message: `Google ${product} returned an invalid response` },
    };
  }
  return {
    product,
    ok: false,
    error: { code: "provider_read_failed", message: `Google ${product} could not be read` },
  };
}

function boundItems<T>(
  values: readonly T[],
  maximumItems: number,
  maximumBytes: number,
): { items: readonly T[]; truncated: boolean } {
  const items: T[] = [];
  let bytes = 2;
  for (const value of values) {
    if (items.length >= maximumItems) {
      return { items, truncated: true };
    }
    const valueBytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes + valueBytes + (items.length === 0 ? 0 : 1) > maximumBytes) {
      return { items, truncated: true };
    }
    items.push(value);
    bytes += valueBytes + (items.length === 1 ? 0 : 1);
  }
  return { items, truncated: false };
}

function compareCalendarEvents(
  left: NormalizedCalendarEvent,
  right: NormalizedCalendarEvent,
): number {
  const leftEpoch = calendarStartEpoch(left);
  const rightEpoch = calendarStartEpoch(right);
  if (leftEpoch !== null && rightEpoch !== null) {
    return leftEpoch - rightEpoch;
  }
  if (leftEpoch !== null) {
    return -1;
  }
  if (rightEpoch !== null) {
    return 1;
  }
  return left.start.value.localeCompare(right.start.value);
}

function calendarStartEpoch(event: NormalizedCalendarEvent): number | null {
  const epoch = Date.parse(
    event.start.kind === "date"
      ? `${event.start.value}T00:00:00.000Z`
      : event.start.value,
  );
  return Number.isFinite(epoch) ? epoch : null;
}

function compareTasks(left: NormalizedTask, right: NormalizedTask): number {
  const leftKey = left.dueDate ?? left.updatedAt ?? "9999";
  const rightKey = right.dueDate ?? right.updatedAt ?? "9999";
  return leftKey.localeCompare(rightKey);
}

function providerStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return null;
  }
  const response = error.response;
  if (typeof response !== "object" || response === null || !("status" in response)) {
    return null;
  }
  return typeof response.status === "number" ? response.status : null;
}

function providerRequestId(headers: unknown): string | undefined {
  for (const name of ["x-request-id", "x-guploader-uploadid"] as const) {
    const value = headerValue(headers, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function googleRetryDelay(error: unknown, attempt: number): number {
  if (providerStatus(error) !== 429 || typeof error !== "object" || error === null) {
    return attempt * 250;
  }
  const headers = "response" in error && typeof error.response === "object" && error.response !== null
    ? Reflect.get(error.response, "headers")
    : undefined;
  const value = headerValue(headers, "retry-after");
  if (value === undefined) {
    return attempt * 250;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(5_000, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(5_000, Math.max(0, date - Date.now())) : attempt * 250;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const getter = Reflect.get(headers, "get");
  if (typeof getter === "function") {
    const value = Reflect.apply(getter, headers, [name]) as unknown;
    return typeof value === "string" ? value : undefined;
  }
  const value = Reflect.get(headers, name) ?? Reflect.get(headers, name.toLowerCase());
  return typeof value === "string" ? value : undefined;
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const timestampJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: "RFC 3339 timestamp",
} as const;
const maximumResultsJsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: 20,
  default: 10,
} as const;
const accountJsonSchema = { type: "string", minLength: 1, maxLength: 160 } as const;
const searchJsonSchema = {
  type: "object",
  properties: {
    account: accountJsonSchema,
    queries: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              product: { const: "calendar" },
              timeMin: timestampJsonSchema,
              timeMax: timestampJsonSchema,
              query: { type: "string", minLength: 1, maxLength: 256 },
              maxResults: maximumResultsJsonSchema,
            },
            required: ["product", "timeMin", "timeMax"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              product: { const: "drive" },
              text: { type: "string", minLength: 1, maxLength: 200 },
              modifiedAfter: timestampJsonSchema,
              modifiedBefore: timestampJsonSchema,
              maxResults: maximumResultsJsonSchema,
            },
            required: ["product"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              product: { const: "contacts" },
              query: { type: "string", minLength: 1, maxLength: 200 },
              maxResults: maximumResultsJsonSchema,
            },
            required: ["product", "query"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              product: { const: "tasks" },
              query: { type: "string", minLength: 1, maxLength: 200 },
              dueBefore: timestampJsonSchema,
              includeCompleted: { type: "boolean", default: false },
              maxResults: maximumResultsJsonSchema,
            },
            required: ["product"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["queries"],
  additionalProperties: false,
} as const;
const readJsonSchema = {
  type: "object",
  oneOf: [
    {
      properties: {
        product: { const: "drive" },
        fileId: { type: "string", minLength: 1, maxLength: 512 },
        account: accountJsonSchema,
      },
      required: ["product", "fileId"],
      additionalProperties: false,
    },
    {
      properties: {
        product: { const: "contacts" },
        contactId: { type: "string", minLength: 1, maxLength: 512 },
        account: accountJsonSchema,
      },
      required: ["product", "contactId"],
      additionalProperties: false,
    },
    {
      properties: {
        product: { const: "tasks" },
        taskListId: { type: "string", minLength: 1, maxLength: 512 },
        taskId: { type: "string", minLength: 1, maxLength: 512 },
        account: accountJsonSchema,
      },
      required: ["product", "taskListId", "taskId"],
      additionalProperties: false,
    },
  ],
} as const;
