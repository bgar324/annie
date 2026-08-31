import { google } from "googleapis";
import type { RuntimeConfig } from "../config.js";
import type { RefreshCoordinator } from "../connections/refresh.js";
import type { ConnectionId, TraceId } from "../core/ids.js";
import { createGoogleOAuthClient, type GoogleCredential } from "../oauth/google.js";

const contactReadMask = [
  "names",
  "emailAddresses",
  "phoneNumbers",
  "organizations",
  "addresses",
  "birthdays",
  "biographies",
  "nicknames",
  "relations",
].join(",");
const maximumDriveTextBytes = 65_536;

const maximumGoogleJsonResponseBytes = 1_024 * 1_024;
export interface GoogleProviderResponse {
  data: unknown;
  headers: unknown;
}

export interface GoogleWorkspaceApi {
  listCalendars(input: {
    pageToken?: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  listEvents(input: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    query?: string;
    pageToken?: string;
    maxResults: number;
    maxAttendees: number;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  listDriveFiles(input: {
    query: string;
    orderByModifiedTime: boolean;
    maxResults: number;
    pageToken?: string;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  getDriveFile(input: { fileId: string; signal?: AbortSignal }): Promise<GoogleProviderResponse>;
  exportDriveText(input: {
    fileId: string;
    mimeType: string;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  downloadDriveText(input: {
    fileId: string;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  warmContacts(input: { signal?: AbortSignal }): Promise<GoogleProviderResponse>;
  searchContacts(input: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  getContact(input: { contactId: string; signal?: AbortSignal }): Promise<GoogleProviderResponse>;
  listTaskLists(input: {
    pageToken?: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  getTaskList(input: {
    taskListId: string;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  listTasks(input: {
    taskListId: string;
    pageToken?: string;
    maxResults: number;
    dueBefore?: string;
    includeCompleted: boolean;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
  getTask(input: {
    taskListId: string;
    taskId: string;
    signal?: AbortSignal;
  }): Promise<GoogleProviderResponse>;
}

export interface GoogleWorkspaceClientProvider {
  forConnection(
    connectionId: ConnectionId,
    traceId: TraceId,
    signal?: AbortSignal,
  ): Promise<GoogleWorkspaceApi>;
}

export class GoogleApisWorkspaceClientProvider implements GoogleWorkspaceClientProvider {
  readonly #config: RuntimeConfig;
  readonly #refresh: RefreshCoordinator;

  constructor(config: RuntimeConfig, refresh: RefreshCoordinator) {
    this.#config = config;
    this.#refresh = refresh;
  }

  async forConnection(
    connectionId: ConnectionId,
    traceId: TraceId,
    signal?: AbortSignal,
  ): Promise<GoogleWorkspaceApi> {
    const credential = await this.#refresh.credentials<GoogleCredential>(
      connectionId,
      traceId,
      Date.now(),
      signal,
    );
    if (credential.accessToken === undefined) {
      throw new Error(`Google connection ${connectionId} has no usable access token`);
    }
    const oauth = createGoogleOAuthClient(this.#config);
    oauth.setCredentials({
      access_token: credential.accessToken,
      ...(credential.tokenType === undefined ? {} : { token_type: credential.tokenType }),
      scope: credential.scopes.join(" "),
    });
    const calendar = google.calendar({ version: "v3", auth: oauth });
    const drive = google.drive({ version: "v3", auth: oauth });
    const people = google.people({ version: "v1", auth: oauth });
    const tasks = google.tasks({ version: "v1", auth: oauth });

    return {
      async listCalendars(input) {
        return calendar.calendarList.list(
          {
            maxResults: input.maxResults,
            minAccessRole: "reader",
            showDeleted: false,
            showHidden: false,
            fields: "nextPageToken,items(id,summary,description,primary,accessRole,timeZone)",
            ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
          },
          requestOptions(input.signal),
        );
      },
      async listEvents(input) {
        return calendar.events.list(
          {
            calendarId: input.calendarId,
            timeMin: input.timeMin,
            timeMax: input.timeMax,
            singleEvents: true,
            orderBy: "startTime",
            showDeleted: false,
            maxResults: input.maxResults,
            maxAttendees: input.maxAttendees,
            fields: "nextPageToken,items(id,status,summary,description,location,htmlLink,hangoutLink,start,end,attendees(email,displayName,responseStatus,organizer,optional),attendeesOmitted,recurrence,recurringEventId,updated)",
            ...(input.query === undefined ? {} : { q: input.query }),
            ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
          },
          requestOptions(input.signal),
        );
      },
      async listDriveFiles(input) {
        return drive.files.list(
          {
            q: input.query,
            pageSize: input.maxResults,
            corpora: "user",
            spaces: "drive",
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,createdTime,size,capabilities(canDownload),clientEncryptionDetails(encryptionState))",
            ...(input.orderByModifiedTime ? { orderBy: "modifiedTime desc" } : {}),
            ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
          },
          requestOptions(input.signal),
        );
      },
      async getDriveFile(input) {
        return drive.files.get(
          {
            fileId: input.fileId,
            supportsAllDrives: true,
            fields: "id,name,mimeType,modifiedTime,createdTime,size,capabilities(canDownload),clientEncryptionDetails(encryptionState)",
          },
          requestOptions(input.signal),
        );
      },
      async exportDriveText(input) {
        const response = await drive.files.export(
          { fileId: input.fileId, mimeType: input.mimeType },
          requestOptions(input.signal, "stream"),
        );
        return {
          data: await readBoundedText(response.data, maximumDriveTextBytes, input.signal),
          headers: response.headers,
        };
      },
      async downloadDriveText(input) {
        const response = await drive.files.get(
          { fileId: input.fileId, alt: "media", supportsAllDrives: true },
          requestOptions(input.signal, "stream", { Range: `bytes=0-${maximumDriveTextBytes}` }),
        );
        return {
          data: await readBoundedText(response.data, maximumDriveTextBytes, input.signal),
          headers: response.headers,
        };
      },
      async warmContacts(input) {
        return people.people.searchContacts(
          { query: "", readMask: contactReadMask, pageSize: 1, sources: ["READ_SOURCE_TYPE_CONTACT"] },
          requestOptions(input.signal),
        );
      },
      async searchContacts(input) {
        return people.people.searchContacts(
          { query: input.query, readMask: contactReadMask, pageSize: input.maxResults, sources: ["READ_SOURCE_TYPE_CONTACT"] },
          requestOptions(input.signal),
        );
      },
      async getContact(input) {
        return people.people.get(
          { resourceName: input.contactId, personFields: contactReadMask, sources: ["READ_SOURCE_TYPE_CONTACT"] },
          requestOptions(input.signal),
        );
      },
      async listTaskLists(input) {
        return tasks.tasklists.list(
          {
            maxResults: input.maxResults,
            ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
          },
          requestOptions(input.signal),
        );
      },
      async getTaskList(input) {
        return tasks.tasklists.get(
          { tasklist: input.taskListId },
          requestOptions(input.signal),
        );
      },
      async listTasks(input) {
        return tasks.tasks.list(
          {
            tasklist: input.taskListId,
            maxResults: input.maxResults,
            showCompleted: input.includeCompleted,
            showHidden: input.includeCompleted,
            showDeleted: false,
            showAssigned: true,
            ...(input.dueBefore === undefined ? {} : { dueMax: input.dueBefore }),
            ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
          },
          requestOptions(input.signal),
        );
      },
      async getTask(input) {
        return tasks.tasks.get(
          { tasklist: input.taskListId, task: input.taskId },
          requestOptions(input.signal),
        );
      },
    };
  }
}

function requestOptions(
  signal: AbortSignal | undefined,
  responseType?: "stream",
  headers?: Record<string, string>,
): {
  retry: false;
  signal?: AbortSignal;
  responseType?: "stream";
  headers?: Record<string, string>;
  maxContentLength?: number;
} {
  return {
    retry: false,
    ...(signal === undefined ? {} : { signal }),
    ...(responseType === undefined ? {} : { responseType }),
    ...(responseType === "stream"
      ? {}
      : { maxContentLength: maximumGoogleJsonResponseBytes }),
    ...(headers === undefined ? {} : { headers }),
  };
}

async function readBoundedText(
  body: unknown,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ content: string; truncated: boolean }> {
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return truncateText(Buffer.isBuffer(body) ? body : Buffer.from(body), maximumBytes);
  }
  if (!isAsyncIterable(body)) {
    throw new TypeError("Google Drive returned a non-streaming text response");
  }
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  for await (const value of body) {
    signal?.throwIfAborted();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const remaining = maximumBytes + 1 - captured;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      chunks.push(kept);
      captured += kept.length;
    }
    if (captured > maximumBytes || chunk.length > remaining) {
      truncated = true;
      destroyStream(body);
      break;
    }
  }
  const clipped = truncateText(Buffer.concat(chunks, Math.min(captured, maximumBytes + 1)), maximumBytes);
  return { content: clipped.content, truncated: truncated || clipped.truncated };
}

function truncateText(buffer: Buffer, maximumBytes: number): { content: string; truncated: boolean } {
  if (buffer.length <= maximumBytes) {
    return { content: buffer.toString("utf8"), truncated: false };
  }
  let end = maximumBytes;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return { content: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function destroyStream(value: AsyncIterable<unknown>): void {
  const destroy = Reflect.get(value, "destroy");
  if (typeof destroy === "function") {
    Reflect.apply(destroy, value, []);
  }
}
