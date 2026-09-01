import { z } from "zod";

import type { RegisteredTool } from "../agent/tools.js";
import type { ConnectionStore } from "./store.js";
import { toSafeConnectionView, type ConnectionProvider } from "./types.js";

const connectArgumentsSchema = z
  .object({ provider: z.enum(["google", "notion"]) })
  .strict();

const unsafeConnectionRequestContextPattern =
  /[\r\n"'`“”‘’]|^\s*(?:>|fwd\s*:|forwarded(?:\s+message)?\s*:)/iu;
const connectionLinkRequestPattern =
  /^(?:please\s+)?(?:send|give)\s+(?:me\s+)?(?:(?:a\s+)?new\s+|another\s+|a\s+)?(?:(?<providerFirst>google|notion)(?:\s+(?:connect(?:ion)?|reconnect))?\s+link|(?:connect(?:ion)?|reconnect)\s+link\s+(?:for|to)\s+(?<providerLast>google|notion))(?:\s+please)?[.!?]*$/iu;

export function explicitConnectRequestProvider(message: string): ConnectionProvider | undefined {
  const trimmed = message.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 256 ||
    unsafeConnectionRequestContextPattern.test(trimmed)
  ) {
    return undefined;
  }
  const match = connectionLinkRequestPattern.exec(trimmed);
  const provider = match?.groups?.providerFirst ?? match?.groups?.providerLast;
  const normalized = provider?.toLowerCase();
  return normalized === "google" || normalized === "notion" ? normalized : undefined;
}

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
      execute: async (argumentsValue) => {
        const { provider } = connectArgumentsSchema.parse(argumentsValue);
        return { provider, connectionLinkWillBeAppended: true };
      },
    },
  ];
}
