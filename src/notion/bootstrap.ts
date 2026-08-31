import { z } from "zod";
import type { ProviderFetch } from "../providers/fetch.js";
import { connectNotionClient, listEveryNotionTool } from "./client.js";

const accessStatusSchema = z.object({
  status: z.enum(["available", "available_with_limit", "upgrade_required", "not_enabled"]),
  upgrade_url: z.string().url().optional(),
});

const selfSchema = z.object({
  self: z.object({
    workspace: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    user: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      type: z.string().min(1),
      email: z.string().email().optional(),
    }),
    current_tool_access: z.record(z.string(), accessStatusSchema),
  }),
});

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export type NotionSelf = z.infer<typeof selfSchema>["self"];

export interface NotionBootstrapIdentity {
  self: NotionSelf;
  advertisedTools: ReadonlySet<string>;
}

export async function fetchNotionBootstrap(input: {
  mcpUrl: string;
  accessToken: string;
  fetch: ProviderFetch;
}): Promise<NotionBootstrapIdentity> {
  const client = await connectNotionClient({
    mcpUrl: input.mcpUrl,
    accessToken: input.accessToken,
    fetch: input.fetch,
  });
  try {
    const advertisedTools = new Set((await listEveryNotionTool(client)).keys());
    const result = toolResultSchema.parse(
      await client.callTool({ name: "notion-fetch", arguments: { id: "self" } }),
    );
    const block = result.content[0];
    if (block?.type !== "text" || block.text === undefined) {
      throw new Error("Notion notion-fetch self did not return a text content block");
    }
    return {
      self: selfSchema.parse(JSON.parse(block.text)).self,
      advertisedTools,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

