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
          "List the accounts connected to Annie right now, including each safe label, provider, live health status, and capabilities. Use this authoritative live result for connection-status questions or when a provider tool reports that the prompt snapshot is stale; ordinary reads already receive a safe account snapshot.",
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
