import { z } from "zod";

import type { RegisteredTool } from "../agent/tools.js";
import type { ConnectionStore } from "./store.js";

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
          "List the accounts connected to Annie right now, including each safe label, provider, health status, and capabilities. Use this as the authoritative source for connection questions.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      operationClass: "read",
      execute: async () => ({
        connections: connections.list().map((connection) => ({
          provider: connection.provider,
          label: connection.safeLabel,
          status: connection.status,
          capabilities: connection.capabilities,
        })),
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
      execute: async (argumentsValue) => {
        const { provider } = connectArgumentsSchema.parse(argumentsValue);
        return { provider, connectionLinkWillBeAppended: true };
      },
    },
  ];
}
