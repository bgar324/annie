import type { ConnectionId } from "../core/ids.js";
import { normalizeSafeLabel, type ConnectionStore } from "./store.js";
import {
  ConnectionRoutingError,
  type ConnectionProvider,
  type ConnectionRecord,
  type ToolCapability,
} from "./types.js";

export class ConnectionRouter {
  readonly #connections: ConnectionStore;

  constructor(connections: ConnectionStore) {
    this.#connections = connections;
  }

  select(input: {
    capability: ToolCapability;
    account?: string;
    connectionId?: ConnectionId;
  }): ConnectionRecord {
    const provider = providerForCapability(input.capability);
    const candidates = this.#connections
      .list(provider)
      .filter((connection) => connection.capabilities.includes(input.capability));

    if (input.connectionId !== undefined) {
      const selected = candidates.find((connection) => connection.id === input.connectionId);
      if (selected === undefined) {
        throw new ConnectionRoutingError({
          code: "connection_not_found",
          message: `No ${provider} connection with that ID grants ${input.capability}`,
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
          message: `No ${provider} connection labeled "${input.account}" grants ${input.capability}`,
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
            ? `No ${provider} connection grants ${input.capability}`
            : `No healthy ${provider} connection grants ${input.capability}`,
        labels: candidates.map((connection) => connection.safeLabel),
      });
    }
    if (healthy.length > 1) {
      throw new ConnectionRoutingError({
        code: "connection_ambiguous",
        message: `Choose a ${provider} account for ${input.capability}: ${healthy
          .map((connection) => connection.safeLabel)
          .join(", ")}`,
        labels: healthy.map((connection) => connection.safeLabel),
      });
    }
    return healthy[0]!;
  }
}

function providerForCapability(capability: ToolCapability): ConnectionProvider {
  return capability.startsWith("gmail.") ? "google" : "notion";
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
