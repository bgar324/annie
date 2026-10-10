import { z } from "zod";

import { parseToolArguments, type RegisteredTool } from "../agent/tools.js";
import type { ConnectionStore } from "./store.js";
import { toSafeConnectionView } from "./types.js";

const connectArgumentsSchema = z
  .object({ provider: z.enum(["google", "notion"]) })
  .strict();

export function parseConnectToolArguments(
  argumentsJson: string,
): z.infer<typeof connectArgumentsSchema> {
  return connectArgumentsSchema.parse(JSON.parse(argumentsJson));
}

export function connectionTools(connections: ConnectionStore): readonly RegisteredTool[] {
  return [
    {
      definition: {
        name: "connections.list",
        description:
          "Read current connection metadata: safe labels, health status, and granted capabilities. Use for account-status questions or a stale account snapshot; ordinary reads already receive a snapshot. This does not call or test provider operations. Healthy means the connection is recorded as usable, and a capability means supported, not that create/update or any particular request succeeded. Do not describe all operations as working from this result.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      operationClass: "read",
      batchMode: "serial",
      execute: async () => ({
        connections: connections.list().map(toSafeConnectionView),
      }),
    },
    {
      definition: {
        name: "connections.connect",
        description:
          "Request a one-time signed link to connect or reconnect Google or Notion. Use only when the current user message explicitly asks to connect a named provider. After this tool succeeds, write the complete reply without a URL; infrastructure appends the signed link.",
        parameters: {
          type: "object",
          properties: {
            provider: { type: "string", enum: ["google", "notion"] },
          },
          required: ["provider"],
          additionalProperties: false,
        },
      },
      operationClass: "read",
      batchMode: "serial",
      execute: async (argumentsValue) => {
        const { provider } = parseToolArguments(connectArgumentsSchema, argumentsValue);
        return { provider, connectionLinkWillBeAppended: true };
      },
    },
  ];
}
