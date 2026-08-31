import type Database from "better-sqlite3";
import type { RuntimeConfig } from "../config.js";
import type { ConnectionId, EgressId, TraceId } from "../core/ids.js";
import type { MessageEgressService } from "../messages/egress.js";
import type { QueueStore } from "../queue/store.js";
import type { ConnectLinkService } from "../oauth/links.js";
import type { ConnectionStore } from "./store.js";
import type { ConnectionProvider } from "./types.js";

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

  sendConnectLink(provider: ConnectionProvider, traceId: TraceId): EgressId {
    const transaction = this.#db.transaction(() => {
      const link = this.#links.issue({ provider, purpose: "connect", traceId });
      const providerName = provider === "google" ? "Google" : "Notion";
      const egressId = this.#egress.prepare({
        traceId,
        recipient: this.#config.userPhoneNumber,
        purpose: "recovery",
        text: `Connect another ${providerName} account: ${link.url}\nThis link expires soon and works once.`,
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
