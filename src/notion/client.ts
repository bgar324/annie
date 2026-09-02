import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import { ModelSafeError } from "../core/errors.js";
import type { RefreshCoordinator } from "../connections/refresh.js";
import type { ConnectionId, TraceId } from "../core/ids.js";
import type { NotionCredential } from "../oauth/notion.js";
import { createTracedProviderFetch, type ProviderFetch } from "../providers/fetch.js";
import type { TraceStore } from "../tracing/store.js";

const toolsPageSchema = z
  .object({
    tools: z.array(
      z
        .object({
          name: z.string().min(1),
          inputSchema: z.record(z.string(), z.unknown()),
        })
        .loose(),
    ),
    nextCursor: z.string().min(1).optional(),
  })
  .loose();

export type NotionUpstreamTool =
  | "notion-search"
  | "notion-fetch"
  | "notion-create-pages"
  | "notion-update-page";

const allowedNotionTools: Record<NotionUpstreamTool, "read" | "write"> = {
  "notion-search": "read",
  "notion-fetch": "read",
  "notion-create-pages": "write",
  "notion-update-page": "write",
};

export interface NotionToolDescriptor {
  name: string;
  inputSchema: Record<string, unknown>;
}

export interface NotionSession {
  validate(name: NotionUpstreamTool, argumentsValue: Record<string, unknown>): void;
  call(name: NotionUpstreamTool, argumentsValue: Record<string, unknown>): Promise<unknown>;
}

export class NotionMcpSession implements NotionSession {
  readonly #client: Client;
  readonly #tools: ReadonlyMap<string, NotionToolDescriptor>;
  readonly #traceId: TraceId;
  readonly #connectionId: ConnectionId;
  readonly #traces: TraceStore;

  constructor(input: {
    client: Client;
    tools: ReadonlyMap<string, NotionToolDescriptor>;
    traceId: TraceId;
    connectionId: ConnectionId;
    traces: TraceStore;
  }) {
    this.#client = input.client;
    this.#tools = input.tools;
    this.#traceId = input.traceId;
    this.#connectionId = input.connectionId;
    this.#traces = input.traces;
  }

  validate(name: NotionUpstreamTool, argumentsValue: Record<string, unknown>): void {
    if (!Object.hasOwn(allowedNotionTools, name)) {
      throw new NotionMcpError("tool_not_allowed", `The assistant does not allow ${name}`);
    }
    const descriptor = this.#tools.get(name);
    if (descriptor === undefined) {
      throw new NotionMcpError("tool_unavailable", `The workspace does not advertise ${name}`);
    }
    const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(
      descriptor.inputSchema,
    );
    if (!validate(argumentsValue)) {
      throw new NotionMcpError(
        "schema_drift",
        `${name} no longer accepts the assistant's narrow argument shape`,
      );
    }
  }

  async call(name: NotionUpstreamTool, argumentsValue: Record<string, unknown>): Promise<unknown> {
    const operationClass = allowedNotionTools[name];
    this.validate(name, argumentsValue);
    this.#traces.append({
      traceId: this.#traceId,
      component: "notion_mcp",
      event: "tool_attempted",
      outcome: name,
      data: { connectionId: this.#connectionId, tool: name, operationClass },
    });
    try {
      const result = await this.#client.callTool({ name, arguments: argumentsValue });
      this.#traces.append({
        traceId: this.#traceId,
        component: "notion_mcp",
        event: "tool_completed",
        outcome: name,
        data: { connectionId: this.#connectionId, tool: name, operationClass },
      });
      return result;
    } catch (error) {
      this.#traces.append({
        traceId: this.#traceId,
        component: "notion_mcp",
        event: "tool_failed",
        outcome: name,
        data: {
          connectionId: this.#connectionId,
          tool: name,
          operationClass,
          error: error instanceof Error ? error.message : "Unknown Notion MCP failure",
        },
      });
      throw error;
    }
  }
}

export interface NotionClientProvider {
  withSession<T>(
    connectionId: ConnectionId,
    traceId: TraceId,
    operation: (session: NotionSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export class HostedNotionClientProvider implements NotionClientProvider {
  readonly #config: RuntimeConfig;
  readonly #refresh: RefreshCoordinator;
  readonly #traces: TraceStore;

  constructor(config: RuntimeConfig, refresh: RefreshCoordinator, traces: TraceStore) {
    this.#config = config;
    this.#refresh = refresh;
    this.#traces = traces;
  }

  async withSession<T>(
    connectionId: ConnectionId,
    traceId: TraceId,
    operation: (session: NotionSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const credential = await this.#refresh.credentials<NotionCredential>(
      connectionId,
      traceId,
      Date.now(),
      signal,
    );
    const fetch = createTracedProviderFetch({
      traces: this.#traces,
      traceId,
      component: "notion_mcp_http",
      timeoutMs: this.#config.limits.providerRequestTimeoutMs,
    });
    const client = await connectNotionClient({
      mcpUrl: this.#config.notion.mcpUrl,
      accessToken: credential.accessToken,
      fetch,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      const tools = await listEveryNotionTool(client);
      return await operation(
        new NotionMcpSession({ client, tools, traceId, connectionId, traces: this.#traces }),
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

export async function connectNotionClient(input: {
  mcpUrl: string;
  accessToken: string;
  fetch: ProviderFetch;
  signal?: AbortSignal;
}): Promise<Client> {
  const streamable = new StreamableHTTPClientTransport(new URL(input.mcpUrl), {
    requestInit: {
      headers: { authorization: `Bearer ${input.accessToken}` },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    fetch: input.fetch,
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: "annie", version: "0.1.0" });
  await client.connect(new CompatibleTransport(streamable));
  return client;
}

export async function listEveryNotionTool(
  client: Client,
): Promise<ReadonlyMap<string, NotionToolDescriptor>> {
  const tools = new Map<string, NotionToolDescriptor>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = toolsPageSchema.parse(
      await client.listTools(cursor === undefined ? undefined : { cursor }),
    );
    for (const tool of page.tools) {
      tools.set(tool.name, { name: tool.name, inputSchema: tool.inputSchema });
    }
    if (page.nextCursor === undefined) {
      return tools;
    }
    cursor = page.nextCursor;
  }
  throw new NotionMcpError("tool_list_too_large", "Notion returned more than 100 tool-list pages");
}

type NotionMcpErrorCode =
  | "tool_not_allowed"
  | "tool_unavailable"
  | "schema_drift"
  | "tool_list_too_large";

export class NotionMcpError extends ModelSafeError<NotionMcpErrorCode> {
  constructor(code: NotionMcpErrorCode, message: string) {
    super("NotionMcpError", code, message);
  }
}

class CompatibleTransport implements Transport {
  readonly #inner: StreamableHTTPClientTransport;
  onclose: () => void = () => undefined;
  onerror: (error: Error) => void = () => undefined;
  onmessage: NonNullable<Transport["onmessage"]> = () => undefined;

  constructor(inner: StreamableHTTPClientTransport) {
    this.#inner = inner;
    inner.onclose = () => this.onclose();
    inner.onerror = (error) => this.onerror(error);
    inner.onmessage = (message) => this.onmessage(message);
  }

  start(): Promise<void> {
    return this.#inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.#inner.send(message, options);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion(version);
  }
}
