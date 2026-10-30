import { isIP } from "node:net";
import { z } from "zod";

const todoEnvSchema = z.object({
  TODO_API_URL: z.url().optional(),
  TODO_AGENT_TOKEN: z.string().min(32).regex(/^[\x21-\x7e]+$/u).optional(),
});

export interface TodoConfig {
  apiUrl: string;
  agentToken: string;
}

export function loadTodoConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: "development" | "test" | "production",
): TodoConfig | undefined {
  const parsed = todoEnvSchema.parse(env);
  if (parsed.TODO_API_URL === undefined && parsed.TODO_AGENT_TOKEN === undefined) return undefined;
  if (parsed.TODO_API_URL === undefined || parsed.TODO_AGENT_TOKEN === undefined) {
    throw new Error("TODO_API_URL and TODO_AGENT_TOKEN must both be set, or both omitted");
  }
  const url = new URL(parsed.TODO_API_URL);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("TODO_API_URL must be an origin without credentials, path, query, or fragment");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (url.protocol !== "https:" && !(nodeEnv !== "production" && loopback && url.protocol === "http:")) {
    throw new Error("TODO_API_URL must use HTTPS, except loopback HTTP in development or test");
  }
  if (nodeEnv === "production" && (
    loopback || isIP(hostname.replace(/^\[|\]$/gu, "")) !== 0 || !hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/u.test(hostname)
  )) {
    throw new Error("TODO_API_URL must use a public HTTPS hostname in production");
  }
  return { apiUrl: url.origin, agentToken: parsed.TODO_AGENT_TOKEN };
}
