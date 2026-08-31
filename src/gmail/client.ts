import { google } from "googleapis";
import type { RuntimeConfig } from "../config.js";
import type { RefreshCoordinator } from "../connections/refresh.js";
import type { ConnectionId, TraceId } from "../core/ids.js";
import { createGoogleOAuthClient, type GoogleCredential } from "../oauth/google.js";

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
  createDraft(input: {
    raw: string;
    threadId?: string;
    signal?: AbortSignal;
  }): Promise<GmailProviderResponse>;
  sendDraft(input: { draftId: string; signal?: AbortSignal }): Promise<GmailProviderResponse>;
}

export interface GmailClientProvider {
  forConnection(
    connectionId: ConnectionId,
    traceId: TraceId,
    signal?: AbortSignal,
  ): Promise<GmailApi>;
}

export class GoogleGmailClientProvider implements GmailClientProvider {
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
  ): Promise<GmailApi> {
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
    const gmail = google.gmail({ version: "v1", auth: oauth });
    return {
      async listMessages(input) {
        return gmail.users.messages.list(
          {
            userId: "me",
            q: input.query,
            maxResults: input.maxResults,
            includeSpamTrash: false,
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
      },
      async getMessage(input) {
        return gmail.users.messages.get(
          {
            userId: "me",
            id: input.messageId,
            format: input.format,
            ...(input.metadataHeaders === undefined
              ? {}
              : { metadataHeaders: [...input.metadataHeaders] }),
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
      },
      async getThread(input) {
        return gmail.users.threads.get(
          {
            userId: "me",
            id: input.threadId,
            format: "full",
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
      },
      async createDraft(input) {
        return gmail.users.drafts.create(
          {
            userId: "me",
            requestBody: {
              message: {
                raw: input.raw,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              },
            },
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
      },
      async sendDraft(input) {
        return gmail.users.drafts.send(
          {
            userId: "me",
            requestBody: { id: input.draftId },
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
      },
    };
  }
}
