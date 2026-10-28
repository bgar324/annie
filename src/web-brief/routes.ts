import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { WebBriefConfig } from "./config.js";
import { attemptSchema, bootstrapSchema, claimSchema, completionSchema, leaseSchema, toolSchema } from "./schema.js";
import type { WebBriefService } from "./service.js";
import { WebBriefError } from "./store.js";

export function registerWebBriefRoutes(app: FastifyInstance, input: { service: WebBriefService; config: WebBriefConfig }): void {
  // Encapsulation keeps private error policy off the existing inbound/OAuth routes.
  void app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store, max-age=0").header("pragma", "no-cache")
        .header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer");
      const expected = request.routeOptions.url === "/internal/brief/bootstrap" ? input.config.adminToken
        : request.routeOptions.url === "/internal/brief/edition" ? input.config.readerToken : input.config.runnerToken;
      if (!authorized(request, expected)) return reply.code(401).send({ error: "unauthorized" });
    });
    scope.setErrorHandler((error, _request, reply) => {
      // Never send/log Zod issues, body, authorization, auth JSON or provider exceptions.
      if (error instanceof WebBriefError) return reply.code(error.statusCode).send({ error: error.code });
      const oversized = typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 413;
      return reply.code(oversized ? 413 : 400).send({ error: oversized ? "body_too_large" : "invalid_request" });
    });
    const options = { bodyLimit: 1_048_576, logLevel: "silent" as const };
    scope.post("/internal/brief/bootstrap", options, async (request) => {
      const body = parse(bootstrapSchema, request.body);
      return input.service.bootstrap(body.auth);
    });
    scope.post("/internal/brief/claim", options, async (request) => input.service.claim(parse(claimSchema, request.body).requestId));
    scope.post("/internal/brief/heartbeat", options, async (request) => input.service.heartbeat(parse(leaseSchema, request.body).leaseToken));
    scope.post("/internal/brief/attempt", options, async (request) => input.service.attempt(parse(attemptSchema, request.body)));
    scope.post("/internal/brief/tool", options, async (request) => input.service.tool(parse(toolSchema, request.body)));
    scope.post("/internal/brief/complete", options, async (request) => input.service.complete(parse(completionSchema, request.body)));
    scope.get("/internal/brief/status", { logLevel: "silent" }, async () => input.service.status());
    scope.get("/internal/brief/edition", { logLevel: "silent" }, async () => input.service.edition());
  });
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WebBriefError("invalid_request", 400);
  return parsed.data;
}
function authorized(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization;
  const actual = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
