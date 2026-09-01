import { randomBytes, timingSafeEqual } from "node:crypto";
import { createPatch } from "diff";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { LocalUiConfig } from "../config.js";
import type { ConnectionStore } from "../connections/store.js";
import { toSafeConnectionView } from "../connections/types.js";
import { newTraceId } from "../core/ids.js";
import {
  type MemoryDocumentStore,
  MemoryValidationError,
} from "../memory/document.js";
import type { ConnectLinkService } from "../oauth/links.js";
import type { TraceStore } from "../tracing/store.js";
import {
  renderLocalUiErrorPage,
  renderLocalUiPage,
  renderMemoryConflictPage,
  type LocalUiNotice,
} from "./page.js";

const formContentType = "application/x-www-form-urlencoded";
const revisionPattern = /^[a-f0-9]{64}$/u;

export interface LocalUiServerInput {
  readonly config: LocalUiConfig;
  readonly publicBaseUrl: string;
  readonly memoryMaximumBytes: number;
  readonly connections: ConnectionStore;
  readonly links: ConnectLinkService;
  readonly memory: MemoryDocumentStore;
  readonly traces: TraceStore;
  readonly isReady: () => boolean;
}

export function createLocalUiApp(input: LocalUiServerInput): FastifyInstance {
  const csrfToken = randomBytes(32).toString("base64url");
  const publicOrigin = new URL(input.publicBaseUrl).origin;
  const app = fastify({
    logger: false,
    bodyLimit: input.memoryMaximumBytes * 3 + 4_096,
  });

  app.addContentTypeParser(
    formContentType,
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, new URLSearchParams(body.toString()));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.host !== expectedAuthority(app, input.config)) {
      return reply.code(421).type("text/plain").send("Misdirected request");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const referrerPolicy =
      (request.method === "GET" || request.method === "HEAD") &&
      request.routeOptions.url === "/"
        ? "same-origin"
        : "no-referrer";
    reply
      .header("cache-control", "no-store, max-age=0")
      .header("referrer-policy", referrerPolicy)
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("cross-origin-resource-policy", "same-origin")
      .header(
        "content-security-policy",
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${publicOrigin} https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'`,
      );
    return payload;
  });

  app.get("/", async (request, reply) => {
    const notice = noticeFromQuery(request.query);
    return sendDashboard(input, reply, csrfToken, notice);
  });

  app.post(
    "/connections/google",
    { config: { logLevel: "silent" } },
    async (request, reply) => {
      const form = requireMutation(request, reply, input.config, csrfToken, ["csrf"]);
      if (form === undefined) {
        return;
      }
      if (!input.isReady()) {
        return sendError(reply, 503, "Annie is still starting", "Reload in a moment and try again.");
      }
      const issued = input.links.issue({
        provider: "google",
        purpose: "connect",
        traceId: newTraceId(),
      });
      return reply.code(303).header("location", issued.url).send();
    },
  );

  app.post("/memory", async (request, reply) => {
    const form = requireMutation(request, reply, input.config, csrfToken, [
      "csrf",
      "expectedRevision",
      "content",
    ]);
    if (form === undefined) {
      return;
    }
    if (!input.isReady()) {
      return sendError(reply, 503, "Annie is still starting", "Reload in a moment and try again.");
    }
    const expectedRevision = oneFormValue(form, "expectedRevision");
    const content = oneFormValue(form, "content");
    if (expectedRevision === undefined || !revisionPattern.test(expectedRevision) || content === undefined) {
      return sendError(reply, 400, "Invalid memory request", "Reload the editor and try again.");
    }

    const traceId = newTraceId();
    let replacement;
    try {
      replacement = input.memory.prepareReplacement(content);
    } catch (error) {
      if (!(error instanceof MemoryValidationError)) {
        throw error;
      }
      input.traces.append({
        traceId,
        component: "memory",
        event: "manual_edit",
        outcome: error.code,
        data: {},
      });
      input.traces.markTerminal(traceId);
      return sendDashboard(
        input,
        reply.code(422),
        csrfToken,
        { kind: "error", message: validationMessage(error.code) },
        error.code === "too_large" ? content : undefined,
      );
    }

    input.traces.append({
      traceId,
      component: "memory",
      event: "manual_edit",
      outcome: "attempting",
      data: {
        expectedRevision,
        proposedRevision: replacement.revision,
        bytes: replacement.bytes,
      },
    });
    const result = await input.memory.replaceIfRevision(expectedRevision, replacement);
    if (result.kind === "conflict") {
      input.traces.append({
        traceId,
        component: "memory",
        event: "manual_edit",
        outcome: "conflict",
        data: {
          expectedRevision,
          currentRevision: result.snapshot.revision,
          proposedRevision: replacement.revision,
        },
      });
      input.traces.markTerminal(traceId);
      return reply
        .code(409)
        .type("text/html; charset=utf-8")
        .send(renderMemoryConflictPage({ current: result.snapshot, draft: content }));
    }

    const replaced = result.kind === "replaced";
    input.traces.append({
      traceId,
      component: "memory",
      event: "manual_edit",
      outcome: replaced ? "updated" : "unchanged",
      data: replaced
        ? {
            beforeRevision: result.previous.revision,
            afterRevision: result.snapshot.revision,
            diff: createPatch("MEMORY.md", result.previous.content, result.snapshot.content),
            bytes: result.snapshot.bytes,
          }
        : {
            beforeRevision: result.snapshot.revision,
            afterRevision: result.snapshot.revision,
            diff: "",
            bytes: result.snapshot.bytes,
          },
    });
    input.traces.markTerminal(traceId);
    const notice = replaced ? "saved" : "unchanged";
    return reply.code(303).header("location", `/?notice=${notice}#status`).send();
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return sendError(reply, 404, "Page not found", "Return to Annie's local control page.");
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (hasStatusCode(error, 413)) {
      return sendError(reply, 413, "Request too large", "Reduce the memory document and try again.");
    }
    return sendError(reply, 500, "Local control failed", "Reload the page and try again.");
  });

  return app;
}

async function sendDashboard(
  input: LocalUiServerInput,
  reply: FastifyReply,
  csrfToken: string,
  notice: LocalUiNotice,
  draft?: string,
): Promise<FastifyReply> {
  const memory = await input.memory.loadSnapshot();
  const accounts = input.connections.list().map(toSafeConnectionView);
  return reply.type("text/html; charset=utf-8").send(
    renderLocalUiPage({
      accounts,
      memory,
      ...(draft === undefined ? {} : { draft }),
      csrfToken,
      ready: input.isReady(),
      notice,
    }),
  );
}

function requireMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  config: LocalUiConfig,
  csrfToken: string,
  fields: readonly string[],
): URLSearchParams | undefined {
  const authority = expectedAuthority(request.server, config);
  const expectedOrigin = `http://${authority}`;
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    request.headers.origin !== expectedOrigin ||
    (fetchSite !== undefined && fetchSite !== "same-origin")
  ) {
    void reply.code(403).type("text/plain").send("Forbidden");
    return undefined;
  }
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== formContentType) {
    void reply.code(415).type("text/plain").send("Unsupported media type");
    return undefined;
  }
  if (!(request.body instanceof URLSearchParams) || !hasExactFields(request.body, fields)) {
    void reply.code(400).type("text/plain").send("Invalid form");
    return undefined;
  }
  const submittedCsrf = oneFormValue(request.body, "csrf");
  if (submittedCsrf === undefined || !equalSecret(submittedCsrf, csrfToken)) {
    void reply.code(403).type("text/plain").send("Forbidden");
    return undefined;
  }
  return request.body;
}

function hasExactFields(form: URLSearchParams, expected: readonly string[]): boolean {
  const names = [...new Set(form.keys())];
  return (
    names.length === expected.length &&
    expected.every((name) => names.includes(name) && form.getAll(name).length === 1)
  );
}

function oneFormValue(form: URLSearchParams, name: string): string | undefined {
  const values = form.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function expectedAuthority(app: FastifyInstance, config: LocalUiConfig): string {
  if (config.port !== 0) {
    return config.authority;
  }
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    return config.authority;
  }
  return `127.0.0.1:${address.port}`;
}


function noticeFromQuery(value: unknown): LocalUiNotice {
  if (typeof value !== "object" || value === null || !("notice" in value)) {
    return undefined;
  }
  if (value.notice === "saved") {
    return { kind: "success", message: "Memory saved. Line endings and trailing whitespace were normalized." };
  }
  if (value.notice === "unchanged") {
    return { kind: "neutral", message: "Memory already matched the saved document." };
  }
  return undefined;
}

function validationMessage(code: MemoryValidationError["code"]): string {
  switch (code) {
    case "invalid_structure":
      return "Memory was not saved. Start with exactly '# Memory' and use lower-level headings after it.";
    case "too_large":
      return "Memory was not saved because it exceeds the configured byte limit.";
    case "forbidden_secret":
      return "Memory was not saved because it contains credential-like text or a signed connection link.";
  }
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  title: string,
  message: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .type("text/html; charset=utf-8")
    .send(renderLocalUiErrorPage(title, message));
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode === statusCode
  );
}
