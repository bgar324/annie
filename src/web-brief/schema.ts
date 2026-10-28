import { z } from "zod";

export const webBriefToolNames = ["gmail.search", "gmail.read_thread", "google.search", "google.read", "notion.search", "notion.fetch"] as const;
const opaque = z.string().min(1).max(128);
const text = z.string().min(1).max(2_048);
export const codexAuthSchema = z.object({
  auth_mode: z.literal("chatgpt").nullable().optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    id_token: z.string().min(1).max(32_768),
    access_token: z.string().min(1).max(32_768),
    refresh_token: z.string().min(1).max(32_768),
    account_id: z.string().min(1).max(256).nullable().optional(),
    oauth_provenance: z.object({
      issuer: z.string().min(1).max(2_048),
      client_id: z.string().min(1).max(256),
    }).strict().nullable().optional(),
    login_owner_id: z.string().min(1).max(256).nullable().optional(),
  }).strict(),
  last_refresh: z.string().datetime({ offset: true }).nullable().optional(),
  agent_identity: z.null().optional(),
  personal_access_token: z.null().optional(),
  bedrock_api_key: z.null().optional(),
  bedrock_access_keys: z.null().optional(),
}).strict();
export const briefSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  title: text.pipe(z.string().max(160)),
  summary: text,
  sections: z.array(z.object({
    title: text.pipe(z.string().max(160)),
    items: z.array(z.object({ text, sourceIds: z.array(opaque).min(1).max(32) }).strict()).min(1).max(12),
  }).strict()).min(1).max(8),
}).strict();
export const bootstrapSchema = z.object({ auth: codexAuthSchema }).strict();
export const claimSchema = z.object({ requestId: opaque }).strict();
export const leaseSchema = z.object({ leaseToken: z.string().min(32).max(128) }).strict();
export const toolSchema = z.object({
  leaseToken: leaseSchema.shape.leaseToken,
  callId: opaque,
  name: z.enum(webBriefToolNames),
  arguments: z.record(z.string(), z.unknown()),
}).strict();
export const attemptSchema = z.object({
  leaseToken: leaseSchema.shape.leaseToken,
  operation: z.enum(["model", "refresh", "models", "bootstrap"]),
  attemptId: opaque,
}).strict();
// Validate the final auth separately from the model output: malformed output must not lose rotation.
export const completionSchema = z.object({
  leaseToken: leaseSchema.shape.leaseToken,
  credentialGeneration: z.number().int().positive(),
  auth: z.unknown(),
  brief: z.unknown(),
  errorCode: z.string().regex(/^[a-z0-9_]{1,80}$/u).nullable(),
}).strict();
export type CodexAuth = z.infer<typeof codexAuthSchema>;
export type Brief = z.infer<typeof briefSchema>;
export interface Edition extends Brief {
  generatedAt: string;
  sources: { id: string; label: string; url: string | null }[];
  coverage: { account: string; product: string; status: "complete" | "unavailable" | "truncated" }[];
}
// The official CLI requires JSON Schema, not a runtime Zod schema.
export const outputSchema = {
  type: "object", additionalProperties: false,
  required: ["date", "title", "summary", "sections"],
  properties: {
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    title: { type: "string", minLength: 1, maxLength: 160 },
    summary: { type: "string", minLength: 1, maxLength: 2048 },
    sections: { type: "array", minItems: 1, maxItems: 8, items: {
      type: "object", additionalProperties: false, required: ["title", "items"],
      properties: { title: { type: "string", minLength: 1, maxLength: 160 }, items: {
        type: "array", minItems: 1, maxItems: 12, items: {
          type: "object", additionalProperties: false, required: ["text", "sourceIds"],
          properties: { text: { type: "string", minLength: 1, maxLength: 2048 }, sourceIds: {
            type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 },
          } },
        },
      } },
    } },
  },
};
