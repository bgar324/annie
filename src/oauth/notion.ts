import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import type { ConnectionStore } from "../connections/store.js";
import {
  OAuthIdentityMismatchError,
  type ConnectionRecord,
  type ConnectionCapability,
} from "../connections/types.js";
import type { OAuthAttemptId } from "../core/ids.js";
import {
  fetchNotionBootstrap,
  type NotionBootstrapIdentity,
  type NotionSelf,
} from "../notion/bootstrap.js";
import { createTracedProviderFetch, type ProviderFetch } from "../providers/fetch.js";
import type { TraceStore } from "../tracing/store.js";
import { OAuthAttemptError, type OAuthAttempt, type OAuthAttemptStore } from "./attempts.js";
import { ConnectLinkError, type ConnectLinkService } from "./links.js";
import { sendOAuthPage } from "./pages.js";

const connectQuerySchema = z.object({ token: z.string().min(1).max(2_048) });
const callbackQuerySchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4_096).optional(),
  error: z.string().max(255).optional(),
});
const initialContextSchema = z.object({
  codeVerifier: z.string().min(32),
  authorizationServerUrl: z.url(),
  tokenEndpoint: z.url(),
  resourceUrl: z.url(),
});
const notionCredentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.string().min(1),
  expiresAtMs: z.number().int().positive().optional(),
  scopes: z.array(z.string()),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
});
const savedContextSchema = z.object({
  providerAccountId: z.string().min(1),
  safeLabel: z.string().min(1),
  safeMetadata: z.record(z.string(), z.unknown()),
  providerState: z.record(z.string(), z.unknown()),
  capabilities: z.array(z.enum([
    "notion.search",
    "notion.fetch",
    "notion.create_page",
    "notion.update_page",
  ])),
  credentials: notionCredentialSchema,
  identityFetched: z.boolean(),
});
const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: z.number().int().positive().optional(),
    scope: z.string().optional(),
    user_id: z.string().min(1),
    workspace_id: z.string().min(1),
    email_domain: z.string().min(1).optional(),
  })
  .loose();

export type NotionCredential = z.infer<typeof notionCredentialSchema>;

export function registerNotionOAuth(input: {
  app: FastifyInstance;
  config: RuntimeConfig;
  links: ConnectLinkService;
  attempts: OAuthAttemptStore;
  connections: ConnectionStore;
  traces: TraceStore;
}): void {
  input.app.get("/.well-known/notion-mcp-client.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return reply.send({
      client_id: input.config.notion.clientMetadataUrl,
      client_name: "Annie",
      client_uri: input.config.publicBaseUrl,
      redirect_uris: [input.config.notion.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  input.app.get(
    "/connect/notion",
    { logLevel: "silent" },
    async (request, reply) => {
      try {
        const query = connectQuerySchema.parse(request.query);
        const link = input.links.resolve(query.token, "notion");
        let attempt = input.attempts.findByLink(link.id);
        if (attempt === undefined) {
          const fetch = tracedFetch(input, link.traceId, "notion_oauth_discovery");
          const discovered = await discoverOAuthServerInfo(input.config.notion.mcpUrl, {
            fetchFn: fetch,
          });
          const authorizationValue =
            discovered.authorizationServerMetadata?.authorization_endpoint;
          const tokenValue = discovered.authorizationServerMetadata?.token_endpoint;
          if (authorizationValue === undefined || tokenValue === undefined) {
            throw new Error("Notion OAuth discovery did not return authorization endpoints");
          }
          const authorizationEndpoint = requireHttpsOAuthEndpoint(
            authorizationValue,
            "authorization",
          );
          const tokenEndpoint = requireHttpsOAuthEndpoint(tokenValue, "token");
          attempt = input.attempts.createOrReuse({
            link,
            build: ({ state, codeChallenge }) => ({
              authorizationUrl: notionAuthorizationUrl({
                endpoint: authorizationEndpoint,
                clientId: input.config.notion.clientMetadataUrl,
                redirectUrl: input.config.notion.callbackUrl,
                resourceUrl: input.config.notion.mcpUrl,
                state,
                codeChallenge,
              }),
              context: {
                authorizationServerUrl: discovered.authorizationServerUrl,
                tokenEndpoint,
                resourceUrl: input.config.notion.mcpUrl,
              },
            }),
          });
        }
        reply.header("cache-control", "no-store, max-age=0");
        reply.header("referrer-policy", "no-referrer");
        return reply.code(303).header("location", attempt.authorizationUrl).send();
      } catch (error) {
        return connectErrorPage(reply, error);
      }
    },
  );

  input.app.get(
    "/oauth/notion/callback",
    { logLevel: "silent" },
    async (request, reply) => {
      let attemptId: OAuthAttemptId | undefined;
      let tokensSaved = false;
      try {
        const query = callbackQuerySchema.parse(request.query);
        const begun = input.attempts.beginExchange<Record<string, unknown>>({
          provider: "notion",
          state: query.state,
        });
        attemptId = begun.attempt.id;
        tokensSaved = begun.attempt.status === "tokens_saved";
        if (begun.attempt.status === "active") {
          return sendOAuthPage(reply, 200, "Notion is connected", "You can close this window.");
        }
        if (begun.attempt.status === "tokens_saved") {
          const connection = await enrichAndFinalizeNotion(input, begun.attempt);
          return successPage(reply, connection);
        }
        if (!begun.fresh) {
          return sendOAuthPage(
            reply,
            409,
            "Notion authorization is processing",
            "Wait a moment, then reload this page once.",
          );
        }
        if (query.error !== undefined) {
          input.attempts.fail(begun.attempt.id, `provider_${query.error}`);
          return sendOAuthPage(
            reply,
            400,
            "Notion was not connected",
            "Authorization was declined. Request a new link in iMessage.",
          );
        }
        if (query.code === undefined) {
          input.attempts.fail(begun.attempt.id, "missing_authorization_code");
          return sendOAuthPage(reply, 400, "Notion was not connected", "The authorization code is missing.");
        }

        const initial = initialContextSchema.parse(begun.attempt.context);
        const fetch = tracedFetch(input, begun.attempt.traceId, "notion_oauth");
        const token = await exchangeNotionCode({
          fetch,
          tokenEndpoint: initial.tokenEndpoint,
          clientId: input.config.notion.clientMetadataUrl,
          redirectUrl: input.config.notion.callbackUrl,
          resourceUrl: initial.resourceUrl,
          code: query.code,
          codeVerifier: initial.codeVerifier,
        });
        const now = Date.now();
        const scopes = uniqueScopes(token.scope?.split(/\s+/u) ?? []);
        const saved = input.attempts.saveExchangeResult({
          attemptId: begun.attempt.id,
          providerIdentity: token.workspace_id,
          context: {
            providerAccountId: token.workspace_id,
            safeLabel: `Notion ${token.workspace_id.slice(-6)}`,
            safeMetadata: {
              workspaceId: token.workspace_id,
              userId: token.user_id,
              ...(token.email_domain === undefined ? {} : { emailDomain: token.email_domain }),
            },
            providerState: { currentToolAccess: {}, scopes, tokenEndpoint: initial.tokenEndpoint },
            capabilities: [],
            credentials: {
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
              tokenType: token.token_type,
              ...(token.expires_in === undefined
                ? {}
                : { expiresAtMs: now + token.expires_in * 1_000 }),
              scopes,
              userId: token.user_id,
              workspaceId: token.workspace_id,
            },
            identityFetched: false,
          },
        });
        tokensSaved = true;
        const connection = await enrichAndFinalizeNotion(input, saved);
        return successPage(reply, connection);
      } catch (error) {
        if (attemptId !== undefined && !tokensSaved) {
          input.attempts.fail(attemptId, oauthFailureCode(error));
        }
        return callbackErrorPage(reply, error, tokensSaved);
      }
    },
  );
}

async function enrichAndFinalizeNotion(
  input: {
    config: RuntimeConfig;
    attempts: OAuthAttemptStore;
    connections: ConnectionStore;
    traces: TraceStore;
  },
  attempt: OAuthAttempt,
): Promise<ConnectionRecord> {
  let saved = savedContextSchema.parse(attempt.context);
  if (!saved.identityFetched) {
    const bootstrap = await fetchNotionBootstrap({
      mcpUrl: input.config.notion.mcpUrl,
      accessToken: saved.credentials.accessToken,
      fetch: tracedFetch(input, attempt.traceId, "notion_mcp_identity"),
    });
    const { self } = bootstrap;
    if (
      self.workspace.id !== saved.credentials.workspaceId ||
      self.user.id !== saved.credentials.userId
    ) {
      throw new Error("Notion workspace identity did not match the token response");
    }
    const context = contextWithNotionSelf(saved, bootstrap);
    const updated = input.attempts.updateSavedContext({
      attemptId: attempt.id,
      context,
      event: "workspace_identified",
    });
    saved = savedContextSchema.parse(updated.context);
  }
  const connection = input.connections.saveAuthorization({
    traceId: attempt.traceId,
    provider: "notion",
    providerAccountId: saved.providerAccountId,
    safeLabel: saved.safeLabel,
    safeMetadata: saved.safeMetadata,
    providerState: saved.providerState,
    capabilities: saved.capabilities,
    credentials: saved.credentials,
    ...(attempt.expectedConnectionId === null
      ? {}
      : { expectedConnectionId: attempt.expectedConnectionId }),
    ...(saved.credentials.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: saved.credentials.expiresAtMs }),
  });
  input.attempts.activate({ attemptId: attempt.id, connectionId: connection.id });
  return connection;
}

function contextWithNotionSelf(
  saved: z.infer<typeof savedContextSchema>,
  bootstrap: NotionBootstrapIdentity,
): z.infer<typeof savedContextSchema> {
  const { self } = bootstrap;
  return {
    ...saved,
    safeLabel: self.workspace.name,
    safeMetadata: {
      ...saved.safeMetadata,
      workspaceName: self.workspace.name,
      userName: self.user.name,
      userType: self.user.type,
    },
    providerState: {
      ...saved.providerState,
      currentToolAccess: self.current_tool_access,
      advertisedTools: [...bootstrap.advertisedTools].sort(),
    },
    capabilities: [...notionCapabilities(self.current_tool_access, bootstrap.advertisedTools)],
    identityFetched: true,
  };
}

const NOTION_CAPABILITY_BINDINGS = [
  { upstream: "notion-search", access: "search", capability: "notion.search" },
  { upstream: "notion-fetch", access: "fetch", capability: "notion.fetch" },
  {
    upstream: "notion-create-pages",
    access: "create_pages",
    capability: "notion.create_page",
  },
  {
    upstream: "notion-update-page",
    access: "update_page",
    capability: "notion.update_page",
  },
] as const satisfies readonly {
  upstream: string;
  access: string;
  capability: ConnectionCapability;
}[];
type NotionCapability = (typeof NOTION_CAPABILITY_BINDINGS)[number]["capability"];


export function notionCapabilities(
  access: NotionSelf["current_tool_access"],
  advertisedTools: ReadonlySet<string>,
): readonly NotionCapability[] {
  return NOTION_CAPABILITY_BINDINGS.filter((binding) => {
    const status = access[binding.access]?.status;
    const usable = status === "available" || status === "available_with_limit";
    return advertisedTools.has(binding.upstream) && usable;
  }).map((binding) => binding.capability);
}

async function exchangeNotionCode(input: {
  fetch: ProviderFetch;
  tokenEndpoint: string;
  clientId: string;
  redirectUrl: string;
  resourceUrl: string;
  code: string;
  codeVerifier: string;
}): Promise<z.infer<typeof tokenResponseSchema>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUrl,
    code_verifier: input.codeVerifier,
    resource: input.resourceUrl,
  });
  const response = await input.fetch(input.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "annie/0.1.0",
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Notion token exchange failed with HTTP ${response.status}`);
  }
  if (Buffer.byteLength(text) > 1_048_576) {
    throw new Error("Notion token response exceeded 1 MiB");
  }
  return tokenResponseSchema.parse(JSON.parse(text));
}

function notionAuthorizationUrl(input: {
  endpoint: string;
  clientId: string;
  redirectUrl: string;
  resourceUrl: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resourceUrl);
  return url.toString();
}

function tracedFetch(
  input: { config: RuntimeConfig; traces: TraceStore },
  traceId: OAuthAttempt["traceId"],
  component: string,
): ProviderFetch {
  return createTracedProviderFetch({
    traces: input.traces,
    traceId,
    component,
    timeoutMs: input.config.limits.providerRequestTimeoutMs,
  });
}

function requireHttpsOAuthEndpoint(value: string, kind: string): string {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error(`Notion OAuth ${kind} endpoint must be credential-free HTTPS`);
  }
  return endpoint.toString();
}

function uniqueScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function connectErrorPage(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ConnectLinkError || error instanceof OAuthAttemptError) {
    const status = error.code === "expired" || error.code === "used" ? 410 : 400;
    return sendOAuthPage(reply, status, "Connection link unavailable", error.message);
  }
  return sendOAuthPage(reply, 502, "Notion connection failed", "Request a new link in iMessage.");
}

function callbackErrorPage(
  reply: FastifyReply,
  error: unknown,
  tokensSaved: boolean,
): FastifyReply {
  if (error instanceof OAuthIdentityMismatchError) {
    return sendOAuthPage(
      reply,
      409,
      "Wrong Notion workspace",
      "Use the same workspace that this reconnection link was issued for.",
    );
  }
  if (error instanceof OAuthAttemptError) {
    return sendOAuthPage(reply, error.code === "expired" ? 410 : 400, "Authorization unavailable", error.message);
  }
  if (error instanceof z.ZodError) {
    return sendOAuthPage(reply, 400, "Invalid Notion callback", "Request a new link in iMessage.");
  }
  return sendOAuthPage(
    reply,
    502,
    "Notion connection needs attention",
    tokensSaved
      ? "The authorization is saved. Reload this page once to finish workspace setup."
      : "Request a new link in iMessage.",
  );
}

function oauthFailureCode(error: unknown): string {
  if (error instanceof OAuthIdentityMismatchError) {
    return "identity_mismatch";
  }
  if (error instanceof OAuthAttemptError) {
    return error.code;
  }
  return "provider_exchange_failed";
}

function successPage(reply: FastifyReply, connection: ConnectionRecord): FastifyReply {
  return sendOAuthPage(
    reply,
    200,
    "Notion is connected",
    `${connection.safeLabel} is ready. You can close this window.`,
  );
}
