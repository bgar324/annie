import type { ConnectionId } from "../core/ids.js";
import { normalizeSafeLabel, type ConnectionStore } from "./store.js";
import {
  ConnectionRoutingError,
  providerForCapability,
  type ConnectionCapability,
  type ConnectionRecord,
} from "./types.js";

export class ConnectionRouter {
  readonly #connections: ConnectionStore;

  constructor(connections: ConnectionStore) {
    this.#connections = connections;
  }

  select(input: {
    capabilities: readonly [ConnectionCapability, ...ConnectionCapability[]];
    account?: string;
    connectionId?: ConnectionId;
  }): ConnectionRecord {
    const [firstCapability, ...otherCapabilities] = input.capabilities;
    const provider = providerForCapability(firstCapability);
    if (otherCapabilities.some((capability) => providerForCapability(capability) !== provider)) {
      throw new TypeError("A connection route cannot span providers");
    }
    const capabilitySummary = input.capabilities.join(", ");
    const candidates = this.#connections
      .list(provider)
      .filter((connection) =>
        input.capabilities.every((capability) => connection.capabilities.includes(capability)),
      );

    if (input.connectionId !== undefined) {
      const selected = candidates.find((connection) => connection.id === input.connectionId);
      if (selected === undefined) {
        throw new ConnectionRoutingError({
          code: "connection_not_found",
          message: `No ${provider} connection with that ID grants ${capabilitySummary}`,
          labels: candidates.map((connection) => connection.safeLabel),
        });
      }
      return requireHealthy(selected);
    }

    if (input.account !== undefined) {
      const normalized = normalizeSafeLabel(input.account);
      const selected = candidates.find(
        (connection) => normalizeSafeLabel(connection.safeLabel) === normalized,
      );
      if (selected === undefined) {
        throw new ConnectionRoutingError({
          code: "connection_not_found",
          message: `No ${provider} connection labeled "${input.account}" grants ${capabilitySummary}`,
          labels: candidates.map((connection) => connection.safeLabel),
        });
      }
      return requireHealthy(selected);
    }

    const healthy = candidates.filter((connection) => connection.status === "healthy");
    if (healthy.length === 0) {
      throw new ConnectionRoutingError({
        code: "capability_unavailable",
        message:
          candidates.length === 0
            ? `No ${provider} connection grants ${capabilitySummary}`
            : `No healthy ${provider} connection grants ${capabilitySummary}`,
        labels: candidates.map((connection) => connection.safeLabel),
      });
    }
    if (healthy.length > 1) {
      throw new ConnectionRoutingError({
        code: "connection_ambiguous",
        message: `Choose a ${provider} account for ${capabilitySummary}: ${healthy
          .map((connection) => connection.safeLabel)
          .join(", ")}`,
        labels: healthy.map((connection) => connection.safeLabel),
      });
    }
    return healthy[0]!;
  }
}

function requireHealthy(connection: ConnectionRecord): ConnectionRecord {
  if (connection.status !== "healthy") {
    throw new ConnectionRoutingError({
      code: "connection_unhealthy",
      message: `${connection.safeLabel} requires reconnection before it can be used`,
      labels: [connection.safeLabel],
    });
  }
  return connection;
}
