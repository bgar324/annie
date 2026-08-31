import { createHash } from "node:crypto";

const SENSITIVE_KEY = /(?:^|_)(?:api_key|authorization|access_token|refresh_token|id_token|client_secret|webhook_secret|encryption_key|credential|password|pkce_verifier|code_verifier|authorization_code|cookie|signature|raw_body|raw_mime|signed_token|reasoning_content)(?:$|_)/iu;
const TOKEN_QUERY_KEY = /^(?:token|code|state|access_token|refresh_token|id_token)$/iu;

export interface TraceRedactor {
  redact(value: unknown): unknown;
  stringify(value: unknown, maxBytes?: number): string;
}

export function createTraceRedactor(secretValues: readonly string[]): TraceRedactor {
  const secrets = [...new Set(secretValues.filter((value) => value.length >= 4))].sort(
    (left, right) => right.length - left.length,
  );

  function sanitizeString(input: string): string {
    let value = input;
    for (const secret of secrets) {
      value = value.replaceAll(secret, "[REDACTED]");
    }
    value = redactUrlQuery(value);
    return value;
  }

  function redact(value: unknown): unknown {
    return visit(value, new WeakSet<object>());
  }

  function visit(value: unknown, ancestors: WeakSet<object>): unknown {
    if (typeof value === "string") {
      return sanitizeString(value);
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return value;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "undefined") {
      return null;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitizeString(value.message),
        stack: value.stack ? sanitizeString(value.stack) : undefined,
        code: errorProperty(value, "code"),
        status: errorProperty(value, "status"),
      };
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return `[binary:${value.byteLength} bytes]`;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value !== "object") {
      return String(value);
    }
    if (ancestors.has(value)) {
      return "[circular]";
    }
    if (Array.isArray(value)) {
      ancestors.add(value);
      const items = value.map((item) => visit(item, ancestors));
      ancestors.delete(value);
      return items;
    }

    ancestors.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : visit(item, ancestors);
    }
    ancestors.delete(value);
    return output;
  }

  return {
    redact,
    stringify(value: unknown, maxBytes = 4_096): string {
      const json = JSON.stringify(redact(value));
      const bytes = Buffer.byteLength(json);
      if (bytes <= maxBytes) {
        return json;
      }
      return JSON.stringify({
        truncated: true,
        bytes,
        sha256: createHash("sha256").update(json).digest("hex"),
      });
    },
  };
}

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[.\\-\\s]+/gu, "_")
    .toLocaleLowerCase("en-US");
  return SENSITIVE_KEY.test(normalized);
}

function redactUrlQuery(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gu, (candidate) => {
    try {
      const url = new URL(candidate);
      for (const key of [...url.searchParams.keys()]) {
        if (TOKEN_QUERY_KEY.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

function errorProperty(error: Error, key: string): unknown {
  if (key in error) {
    const value = Reflect.get(error, key);
    if (typeof value === "string" || typeof value === "number") {
      return value;
    }
  }
  return undefined;
}
