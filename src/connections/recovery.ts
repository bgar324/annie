import type Database from "better-sqlite3";
import type { RuntimeConfig } from "../config.js";
import {
  newTraceId,
  type ConnectionId,
  type EgressId,
  type RunId,
  type TraceId,
} from "../core/ids.js";
import type { MessageEgressService } from "../messages/egress.js";
import type { QueueStore } from "../queue/store.js";
import type { ConnectLinkService } from "../oauth/links.js";
import type { ConnectionStore } from "./store.js";
import type { ConnectionProvider } from "./types.js";

const maximumConnectReplyBytes = 512;
const markdownLinkPattern =
  /!?\[[^\]\r\n]*\]\(\s*[^)\s]+(?:\s+["'][^"'\r\n]*["'])?\s*\)/u;
const uriSchemePattern =
  /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]{1,31}:(?=\/\/|\S)/iu;
const domainPattern =
  /(?:^|[^\p{L}\p{N}_-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59})(?=$|[^\p{L}\p{N}_-])/iu;
const hostLiteralPattern =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|localhost)(?::\d{1,5})?(?=$|[/?#\s<>)])/iu;
const htmlUrlAttributePattern = /\b(?:href|src)\s*=/iu;

export class ConnectionRecoveryService {
  readonly #db: Database.Database;
  readonly #config: RuntimeConfig;
  readonly #connections: ConnectionStore;
  readonly #links: ConnectLinkService;
  readonly #egress: MessageEgressService;
  readonly #queue: QueueStore;

  constructor(input: {
    db: Database.Database;
    config: RuntimeConfig;
    connections: ConnectionStore;
    links: ConnectLinkService;
    egress: MessageEgressService;
    queue: QueueStore;
  }) {
    this.#db = input.db;
    this.#config = input.config;
    this.#connections = input.connections;
    this.#links = input.links;
    this.#egress = input.egress;
    this.#queue = input.queue;
  }

  planReconnect(connectionId: ConnectionId, traceId: TraceId): EgressId | undefined {
    const connection = this.#connections.getRequired(connectionId);
    if (connection.status !== "reconnect_required") {
      return undefined;
    }
    const existing = this.#db
      .prepare<
        { connection_id: string; health_generation: number },
        { egress_id: EgressId }
      >(`
        SELECT egress_id FROM recovery_notices
        WHERE connection_id = @connection_id AND health_generation = @health_generation
      `)
      .get({ connection_id: connection.id, health_generation: connection.healthGeneration });
    if (existing !== undefined) {
      return existing.egress_id;
    }

    const transaction = this.#db.transaction(() => {
      const link = this.#links.issue({
        provider: connection.provider,
        purpose: "reconnect",
        traceId,
        expectedConnectionId: connection.id,
      });
      const egressId = this.#egress.prepare({
        traceId,
        recipient: this.#config.userPhoneNumber,
        purpose: "recovery",
        text: `${connection.safeLabel} needs to be reconnected: ${link.url}\nThis link expires soon and works once.`,
      });
      this.#db
        .prepare<{
          connection_id: string;
          health_generation: number;
          oauth_link_id: string;
          egress_id: string;
          now_ms: number;
        }>(`
          INSERT INTO recovery_notices(
            connection_id, health_generation, oauth_link_id, egress_id,
            status, created_at_ms, attempted_at_ms
          ) VALUES (
            @connection_id, @health_generation, @oauth_link_id, @egress_id,
            'planned', @now_ms, NULL
          )
        `)
        .run({
          connection_id: connection.id,
          health_generation: connection.healthGeneration,
          oauth_link_id: link.id,
          egress_id: egressId,
          now_ms: Date.now(),
        });
      this.#queue.enqueueInTransaction({
        chatId: this.#config.userPhoneNumber,
        type: "egress_send",
        subjectId: egressId,
        payload: { egressId },
        traceId,
        capacityExempt: true,
      });
      return egressId;
    });
    return transaction.immediate();
  }
  planPendingReconnects(provider: ConnectionProvider): readonly EgressId[] {
    return this.#connections
      .list(provider)
      .filter((connection) => connection.status === "reconnect_required")
      .flatMap((connection) => {
        const egressId = this.planReconnect(connection.id, newTraceId());
        return egressId === undefined ? [] : [egressId];
      });
  }

  sendConnectLink(
    provider: ConnectionProvider,
    traceId: TraceId,
    runId: RunId,
    message: string,
  ): EgressId {
    const safeMessage = validateConnectReply(message);
    const transaction = this.#db.transaction(() => {
      const existing = this.#db
        .prepare<{ run_id: string; trace_id: string }, { id: EgressId }>(`
          SELECT id FROM egress_messages
          WHERE run_id = @run_id AND trace_id = @trace_id AND purpose = 'recovery'
          ORDER BY created_at_ms, id
          LIMIT 1
        `)
        .get({ run_id: runId, trace_id: traceId });
      if (existing !== undefined) {
        return existing.id;
      }
      const run = this.#db
        .prepare<{ run_id: string }, { request_scope: string | null }>(`
          SELECT request_scope FROM agent_runs WHERE id = @run_id
        `)
        .get({ run_id: runId });
      if (run?.request_scope !== `connect_${provider}`) {
        throw new Error("Connection link requires matching current-request permission");
      }
      const link = this.#links.issue({ provider, purpose: "connect", traceId });
      const egressId = this.#egress.prepare({
        traceId,
        runId,
        recipient: this.#config.userPhoneNumber,
        purpose: "recovery",
        text: `${safeMessage}\n${link.url}`,
      });
      this.#queue.enqueueInTransaction({
        chatId: this.#config.userPhoneNumber,
        type: "egress_send",
        subjectId: egressId,
        payload: { egressId },
        traceId,
        capacityExempt: true,
      });
      return egressId;
    });
    return transaction.immediate();
  }
}

function validateConnectReply(message: string): string {
  const trimmed = message.trim().replace(/\r\n?/gu, "\n");
  if (trimmed.length === 0 || Buffer.byteLength(trimmed) > maximumConnectReplyBytes) {
    throw new TypeError("Connection-link reply must contain 1–512 bytes");
  }
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(trimmed)) {
    throw new TypeError("Connection-link reply cannot contain control characters");
  }
  if (
    markdownLinkPattern.test(trimmed) ||
    uriSchemePattern.test(trimmed) ||
    domainPattern.test(trimmed) ||
    hostLiteralPattern.test(trimmed) ||
    htmlUrlAttributePattern.test(trimmed)
  ) {
    throw new TypeError(
      "Connection-link reply cannot contain a model-authored URL or domain",
    );
  }
  return trimmed;
}
