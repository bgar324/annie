import { loadEnvFile } from "node:process";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const nodeEnvSchema = z.enum(["development", "test", "production"]);
const nonEmpty = z.string().trim().min(1);
const positiveInteger = (fallback: number, maximum: number) =>
  z.coerce.number().int().positive().max(maximum).default(fallback);
const e164Number = z.string().trim().regex(/^\+[1-9]\d{7,14}$/u);
const dailyBriefTimeZone = "America/Los_Angeles" as const;
export const GOOGLE_WORKSPACE_READ_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/tasks.readonly",
] as const;
const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const storageEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  RAILWAY_VOLUME_MOUNT_PATH: nonEmpty.optional(),
  DATA_DIR: nonEmpty.optional(),
  DATABASE_PATH: nonEmpty.optional(),
  MEMORY_PATH: nonEmpty.optional(),
  TRACE_DIR: nonEmpty.optional(),
  TRACE_RETENTION_DAYS: positiveInteger(30, 365),
  TRACE_MAX_BYTES: positiveInteger(536_870_912, 10_737_418_240),
});

const runtimeEnvSchema = storageEnvSchema.extend({
  PORT: positiveInteger(3000, 65_535),
  HOST: nonEmpty.default("0.0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  SENDBLUE_API_KEY_ID: nonEmpty,
  SENDBLUE_API_SECRET_KEY: nonEmpty,
  SENDBLUE_FROM_NUMBER: e164Number,
  SENDBLUE_BASE_URL: z.url().default("https://api.sendblue.co"),
  USER_PHONE_NUMBER: e164Number,

  PUBLIC_BASE_URL: z.url(),
  GEMINI_API_KEY: nonEmpty,
  GEMINI_MODEL: nonEmpty.default("gemini-3.7-flash"),
  GEMINI_BASE_URL: z
    .url()
    .default("https://generativelanguage.googleapis.com/v1beta/openai"),
  GEMINI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),

  GOOGLE_CLIENT_ID: nonEmpty,
  GOOGLE_CLIENT_SECRET: nonEmpty,


  CREDENTIAL_ENCRYPTION_KEY: nonEmpty,
  NOTION_MCP_URL: z.url().default("https://mcp.notion.com/mcp"),
  DAILY_BRIEF_ENABLED: booleanFlag,
  MAX_AGENT_TOOL_ROUNDS: positiveInteger(6, 12),
  MAX_AGENT_RUN_MS: positiveInteger(120_000, 600_000),
  MAX_AGENT_TOOL_CALLS: positiveInteger(16, 32),
  MAX_AGENT_WRITES: positiveInteger(2, 8),
  MEMORY_MAX_BYTES: positiveInteger(16_384, 16_384),
  RECENT_MESSAGE_LIMIT: positiveInteger(20, 100),
  WORKER_POLL_MS: positiveInteger(250, 60_000),
  JOB_LEASE_MS: positiveInteger(180_000, 900_000),
  MAX_PENDING_JOBS: positiveInteger(256, 4_096),
  OAUTH_LINK_TTL_MS: positiveInteger(600_000, 3_600_000),
  PROVIDER_REQUEST_TIMEOUT_MS: positiveInteger(30_000, 120_000),
});

const localUiEnvSchema = z.object({
  LOCAL_UI_ENABLED: booleanFlag,
  LOCAL_UI_PORT: positiveInteger(3001, 65_535),
});

export interface StorageConfig {
  nodeEnv: z.infer<typeof nodeEnvSchema>;
  dataDir: string;
  databasePath: string;
  memoryPath: string;
  traceDir: string;
  traceRetentionDays: number;
  traceMaxBytes: number;
}

export interface LocalUiConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly authority: `127.0.0.1:${number}`;
  readonly origin: `http://127.0.0.1:${number}`;
}

export interface RuntimeConfig extends StorageConfig {
  port: number;
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
  sendblue: {
    apiKeyId: string;
    apiSecretKey: string;
    fromNumber: string;
    baseUrl: string;
  };
  userPhoneNumber: string;
  publicBaseUrl: string;
  gemini: {
    apiKey: string;
    model: string;
    baseUrl: string;
    reasoningEffort: "low" | "medium" | "high";
  };
  google: {
    clientId: string;
    clientSecret: string;
    scopes: readonly string[];
    callbackUrl: string;
  };
  credentialEncryptionKey: Buffer;
  notion: {
    mcpUrl: string;
    callbackUrl: string;
    clientMetadataUrl: string;
  };
  dailyBrief: {
    enabled: boolean;
    timeZone: typeof dailyBriefTimeZone;
  };
  limits: {
    maxAgentToolRounds: number;
    maxAgentRunMs: number;
    maxAgentToolCalls: number;
    maxAgentWrites: number;
    memoryMaxBytes: number;
    recentMessageLimit: number;
    workerPollMs: number;
    jobLeaseMs: number;
    maxPendingJobs: number;
    oauthLinkTtlMs: number;
    providerRequestTimeoutMs: number;
  };
  secretValues: readonly string[];
}

export function loadLocalEnv(path = ".env"): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const parsed = storageEnvSchema.parse(env);
  const volumePath = parsed.RAILWAY_VOLUME_MOUNT_PATH
    ? resolve(parsed.RAILWAY_VOLUME_MOUNT_PATH)
    : undefined;

  if (parsed.NODE_ENV === "production" && volumePath === undefined) {
    throw new Error("RAILWAY_VOLUME_MOUNT_PATH is required in production");
  }

  const dataDir = resolve(parsed.DATA_DIR ?? volumePath ?? "data");
  if (parsed.NODE_ENV === "production" && dataDir !== volumePath) {
    throw new Error("DATA_DIR must equal RAILWAY_VOLUME_MOUNT_PATH in production");
  }

  const databasePath = resolveDataPath(dataDir, parsed.DATABASE_PATH, "assistant.sqlite");
  const memoryPath = resolveDataPath(dataDir, parsed.MEMORY_PATH, "MEMORY.md");
  const traceDir = resolveDataPath(dataDir, parsed.TRACE_DIR, "traces");

  if (parsed.NODE_ENV === "production") {
    assertWithin(dataDir, databasePath, "DATABASE_PATH");
    assertWithin(dataDir, memoryPath, "MEMORY_PATH");
    assertWithin(dataDir, traceDir, "TRACE_DIR");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    dataDir,
    databasePath,
    memoryPath,
    traceDir,
    traceRetentionDays: parsed.TRACE_RETENTION_DAYS,
    traceMaxBytes: parsed.TRACE_MAX_BYTES,
  };
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = runtimeEnvSchema.parse(env);
  const storage = loadStorageConfig(env);
  const publicBaseUrl = normalizeOrigin(parsed.PUBLIC_BASE_URL, parsed.NODE_ENV);
  const credentialEncryptionKey = decodeMasterKey(parsed.CREDENTIAL_ENCRYPTION_KEY);
  validateProviderUrl(parsed.SENDBLUE_BASE_URL, "SENDBLUE_BASE_URL", parsed.NODE_ENV);
  validateProviderUrl(parsed.GEMINI_BASE_URL, "GEMINI_BASE_URL", parsed.NODE_ENV);
  validateProviderUrl(parsed.NOTION_MCP_URL, "NOTION_MCP_URL", parsed.NODE_ENV);


  return {
    ...storage,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    sendblue: {
      apiKeyId: parsed.SENDBLUE_API_KEY_ID,
      apiSecretKey: parsed.SENDBLUE_API_SECRET_KEY,
      fromNumber: parsed.SENDBLUE_FROM_NUMBER,
      baseUrl: trimTrailingSlash(parsed.SENDBLUE_BASE_URL),
    },
    userPhoneNumber: parsed.USER_PHONE_NUMBER,
    publicBaseUrl,
    gemini: {
      apiKey: parsed.GEMINI_API_KEY,
      model: parsed.GEMINI_MODEL,
      baseUrl: trimTrailingSlash(parsed.GEMINI_BASE_URL),
      reasoningEffort: parsed.GEMINI_REASONING_EFFORT,
    },
    google: {
      clientId: parsed.GOOGLE_CLIENT_ID,
      clientSecret: parsed.GOOGLE_CLIENT_SECRET,
      scopes: GOOGLE_WORKSPACE_READ_SCOPES,
      callbackUrl: `${publicBaseUrl}/oauth/google/callback`,
    },
    credentialEncryptionKey,
    notion: {
      mcpUrl: parsed.NOTION_MCP_URL,
      callbackUrl: `${publicBaseUrl}/oauth/notion/callback`,
      clientMetadataUrl: `${publicBaseUrl}/.well-known/notion-mcp-client.json`,
    },
    dailyBrief: {
      enabled: parsed.DAILY_BRIEF_ENABLED,
      timeZone: dailyBriefTimeZone,
    },
    limits: {
      maxAgentToolRounds: parsed.MAX_AGENT_TOOL_ROUNDS,
      maxAgentRunMs: parsed.MAX_AGENT_RUN_MS,
      maxAgentToolCalls: parsed.MAX_AGENT_TOOL_CALLS,
      maxAgentWrites: parsed.MAX_AGENT_WRITES,
      memoryMaxBytes: parsed.MEMORY_MAX_BYTES,
      recentMessageLimit: parsed.RECENT_MESSAGE_LIMIT,
      workerPollMs: parsed.WORKER_POLL_MS,
      jobLeaseMs: parsed.JOB_LEASE_MS,
      maxPendingJobs: parsed.MAX_PENDING_JOBS,
      oauthLinkTtlMs: parsed.OAUTH_LINK_TTL_MS,
      providerRequestTimeoutMs: parsed.PROVIDER_REQUEST_TIMEOUT_MS,
    },
    secretValues: [
      parsed.SENDBLUE_API_KEY_ID,
      parsed.SENDBLUE_API_SECRET_KEY,
      parsed.GEMINI_API_KEY,
      parsed.GOOGLE_CLIENT_SECRET,
      parsed.CREDENTIAL_ENCRYPTION_KEY,
    ],
  };
}

export function loadLocalUiConfig(
  config: Pick<RuntimeConfig, "port">,
  env: NodeJS.ProcessEnv = process.env,
): LocalUiConfig | undefined {
  const parsed = localUiEnvSchema.parse(env);
  if (!parsed.LOCAL_UI_ENABLED) {
    return undefined;
  }
  const port = parsed.LOCAL_UI_PORT;
  if (port === config.port) {
    throw new Error("LOCAL_UI_PORT must differ from PORT");
  }
  return {
    host: "127.0.0.1",
    port,
    authority: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
  };
}


function decodeMasterKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be standard base64");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function normalizeOrigin(value: string, nodeEnv: z.infer<typeof nodeEnvSchema>): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PUBLIC_BASE_URL must be an origin without credentials, path, query, or fragment");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(nodeEnv !== "production" && localHttp)) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS outside local development");
  }
  return url.origin;
}

function validateProviderUrl(
  value: string,
  variable: string,
  nodeEnv: z.infer<typeof nodeEnvSchema>,
): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${variable} cannot contain credentials, query parameters, or a fragment`);
  }
  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error(`${variable} must use HTTPS in production`);
  }
}

function resolveDataPath(dataDir: string, configured: string | undefined, fallback: string): string {
  if (configured === undefined) {
    return resolve(dataDir, fallback);
  }
  return isAbsolute(configured) ? resolve(configured) : resolve(dataDir, configured);
}

function assertWithin(root: string, child: string, variable: string): void {
  const pathFromRoot = relative(root, child);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`${variable} must stay within the Railway volume`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
