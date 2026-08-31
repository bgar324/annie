import type { RuntimeConfig } from "../config.js";
import type { RefreshCoordinator } from "../connections/refresh.js";
import type { ConnectionId, TraceId } from "../core/ids.js";
import type { GoogleCredential } from "../oauth/google.js";

export interface GmailProviderResponse {
  data: unknown;
  headers: unknown;
}

export interface GmailApi {
  listMessages(input: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GmailProviderResponse>;
  getMessage(input: {
    messageId: string;
    format: "metadata" | "full";
    metadataHeaders?: readonly string[];
    signal?: AbortSignal;
  }): Promise<GmailProviderResponse>;
  getThread(input: { threadId: string; signal?: AbortSignal }): Promise<GmailProviderResponse>;
}

export interface GmailClientProvider {
  forConnection(
    connectionId: ConnectionId,
    traceId: TraceId,
    signal?: AbortSignal,
  ): Promise<GmailApi>;
}

export class GoogleGmailClientProvider implements GmailClientProvider {
  readonly #refresh: RefreshCoordinator;
  readonly #fetch: typeof fetch;

  constructor(_config: RuntimeConfig, refresh: RefreshCoordinator, fetchImpl: typeof fetch = fetch) {
    this.#refresh = refresh;
    this.#fetch = fetchImpl;
  }

  async forConnection(
    connectionId: ConnectionId,
    traceId: TraceId,
    signal?: AbortSignal,
  ): Promise<GmailApi> {
    const credential = await this.#refresh.credentials<GoogleCredential>(
      connectionId,
      traceId,
      Date.now(),
      signal,
    );
    const accessToken = credential.accessToken;
    if (accessToken === undefined) {
      throw new Error(`Google connection ${connectionId} has no usable access token`);
    }
    const request = (
      path: string,
      query: readonly (readonly [string, string])[],
      maximumResponseBytes: number,
      requestSignal: AbortSignal | undefined,
    ) =>
      gmailJsonRequest(
        this.#fetch,
        accessToken,
        path,
        query,
        maximumResponseBytes,
        requestSignal,
      );
    return {
      async listMessages(input) {
        return request(
          "messages",
          [
            ["q", input.query],
            ["maxResults", String(input.maxResults)],
            ["includeSpamTrash", "false"],
            ["fields", "messages(id,threadId),resultSizeEstimate"],
          ],
          maximumMetadataResponseBytes,
          input.signal,
        );
      },
      async getMessage(input) {
        const query: [string, string][] = [
          ["format", input.format],
          [
            "fields",
            input.format === "metadata"
              ? "id,threadId,labelIds,snippet,internalDate,payload(headers(name,value))"
              : "id,threadId,labelIds,snippet,internalDate,payload",
          ],
        ];
        for (const header of input.metadataHeaders ?? []) {
          query.push(["metadataHeaders", header]);
        }
        return request(
          `messages/${encodeURIComponent(input.messageId)}`,
          query,
          input.format === "metadata" ? maximumMetadataResponseBytes : maximumFullResponseBytes,
          input.signal,
        );
      },
      async getThread(input) {
        return request(
          `threads/${encodeURIComponent(input.threadId)}`,
          [
            ["format", "full"],
            ["fields", "id,historyId,messages(id,threadId,labelIds,snippet,internalDate,payload)"],
          ],
          maximumFullResponseBytes,
          input.signal,
        );
      },
    };
  }
}

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me/";
const maximumMetadataResponseBytes = 512 * 1_024;
const maximumFullResponseBytes = 8 * 1_024 * 1_024;

async function gmailJsonRequest(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
  query: readonly (readonly [string, string])[],
  maximumResponseBytes: number,
  signal: AbortSignal | undefined,
): Promise<GmailProviderResponse> {
  const url = new URL(path, gmailApiBaseUrl);
  for (const [name, value] of query) {
    url.searchParams.append(name, value);
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailHttpError(response.status, response.headers, `Gmail returned HTTP ${response.status}`);
  }
  return {
    data: await boundedJson(response, maximumResponseBytes),
    headers: response.headers,
  };
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailHttpError(413, response.headers, "Gmail response exceeded the byte limit");
  }
  if (response.body === null) {
    throw new GmailHttpError(502, response.headers, "Gmail returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GmailHttpError(413, response.headers, "Gmail response exceeded the byte limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch (cause) {
    throw new GmailHttpError(502, response.headers, "Gmail returned invalid JSON", { cause });
  }
}

class GmailHttpError extends Error {
  readonly response: { readonly status: number; readonly headers: Headers };

  constructor(status: number, headers: Headers, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GmailHttpError";
    this.response = { status, headers };
  }
}
