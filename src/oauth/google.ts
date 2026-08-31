import type { FastifyInstance, FastifyReply } from "fastify";
import { Auth } from "googleapis";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import type { ConnectionStore } from "../connections/store.js";
import {
  OAuthIdentityMismatchError,
  type ConnectionRecord,
  type ToolCapability,
} from "../connections/types.js";
import type { ConnectionId, OAuthAttemptId } from "../core/ids.js";
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
  nonce: z.string().min(32),
});

const credentialSchema = z.object({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1),
  expiryDateMs: z.number().int().positive().optional(),
  tokenType: z.string().min(1).optional(),
  scopes: z.array(z.string()),
});

const savedContextSchema = z.object({
  providerAccountId: z.string().min(1),
  safeLabel: z.string().min(1),
  safeMetadata: z.record(z.string(), z.unknown()),
  providerState: z.record(z.string(), z.unknown()),
  capabilities: z.array(z.enum([
    "gmail.search",
    "gmail.read_thread",
    "gmail.create_draft",
    "gmail.send_draft",
  ])),
  credentials: credentialSchema,
});

export type GoogleCredential = z.infer<typeof credentialSchema>;

export function registerGoogleOAuth(input: {
  app: FastifyInstance;
  config: RuntimeConfig;
  links: ConnectLinkService;
  attempts: OAuthAttemptStore;
  connections: ConnectionStore;
  traces: TraceStore;
}): void {
  input.app.get(
    "/connect/google",
    { logLevel: "silent" },
    async (request, reply) => {
      try {
        const query = connectQuerySchema.parse(request.query);
        const link = input.links.resolve(query.token, "google");
        const oauth = createGoogleOAuthClient(input.config);
        const attempt = input.attempts.createOrReuse({
          link,
          build: ({ state, codeChallenge, nonce }) => ({
            authorizationUrl: oauth.generateAuthUrl({
              access_type: "offline",
              prompt: "consent select_account",
              include_granted_scopes: true,
              scope: [...input.config.google.scopes],
              state,
              nonce,
              code_challenge: codeChallenge,
              code_challenge_method: Auth.CodeChallengeMethod.S256,
            }),
            context: {},
          }),
        });
        reply.header("cache-control", "no-store, max-age=0");
        reply.header("referrer-policy", "no-referrer");
        return reply.code(303).header("location", attempt.authorizationUrl).send();
      } catch (error) {
        return connectErrorPage(reply, error);
      }
    },
  );

  input.app.get(
    "/oauth/google/callback",
    { logLevel: "silent" },
    async (request, reply) => {
      let attemptId: OAuthAttemptId | undefined;
      let tokensSaved = false;
      try {
        const query = callbackQuerySchema.parse(request.query);
        const begun = input.attempts.beginExchange<Record<string, unknown>>({
          provider: "google",
          state: query.state,
        });
        attemptId = begun.attempt.id;
        tokensSaved = begun.attempt.status === "tokens_saved";
        if (begun.attempt.status === "active") {
          return sendOAuthPage(reply, 200, "Google is connected", "You can close this window.");
        }
        if (begun.attempt.status === "tokens_saved") {
          const connection = finalizeGoogleConnection(input, begun.attempt);
          return successPage(reply, connection);
        }
        if (!begun.fresh) {
          return sendOAuthPage(
            reply,
            409,
            "Google authorization is processing",
            "Wait a moment. If no iMessage arrives, request a new connection link.",
          );
        }
        if (query.error !== undefined) {
          input.attempts.fail(begun.attempt.id, `provider_${query.error}`);
          return sendOAuthPage(
            reply,
            400,
            "Google was not connected",
            "Authorization was declined or could not be completed. Request a new link in iMessage.",
          );
        }
        if (query.code === undefined) {
          input.attempts.fail(begun.attempt.id, "missing_authorization_code");
          return sendOAuthPage(reply, 400, "Google was not connected", "The authorization code is missing.");
        }

        const initial = initialContextSchema.parse(begun.attempt.context);
        const oauth = createGoogleOAuthClient(input.config);
        input.traces.append({
          traceId: begun.attempt.traceId,
          component: "google_oauth",
          event: "token_exchange_attempted",
          outcome: "google",
          data: { attemptId: begun.attempt.id },
        });
        const tokenResponse = await oauth.getToken({
          code: query.code,
          codeVerifier: initial.codeVerifier,
        });
        const tokens = tokenResponse.tokens;
        if (tokens.id_token === undefined || tokens.id_token === null) {
          throw new Error("Google did not return the required OpenID identity token");
        }
        const ticket = await oauth.verifyIdToken({
          idToken: tokens.id_token,
          audience: input.config.google.clientId,
        });
        const identity = ticket.getPayload();
        if (identity?.sub === undefined || identity.nonce !== initial.nonce) {
          throw new Error("Google returned an invalid OpenID identity");
        }

        const scopes = await actualGoogleScopes(oauth, tokens.scope, tokens.access_token);
        const refreshToken = existingOrNewRefreshToken(
          input.connections,
          identity.sub,
          begun.attempt.expectedConnectionId,
          tokens.refresh_token,
        );
        const safeLabel = identity.email ?? `Google ${identity.sub.slice(-6)}`;
        const saved = input.attempts.saveExchangeResult({
          attemptId: begun.attempt.id,
          providerIdentity: identity.sub,
          context: {
            providerAccountId: identity.sub,
            safeLabel,
            safeMetadata: {
              ...(identity.email === undefined ? {} : { email: identity.email }),
              emailVerified: identity.email_verified === true,
            },
            providerState: { scopes },
            capabilities: googleCapabilities(scopes),
            credentials: {
              ...(tokens.access_token === undefined || tokens.access_token === null
                ? {}
                : { accessToken: tokens.access_token }),
              refreshToken,
              ...(tokens.expiry_date === undefined || tokens.expiry_date === null
                ? {}
                : { expiryDateMs: tokens.expiry_date }),
              ...(tokens.token_type === undefined || tokens.token_type === null
                ? {}
                : { tokenType: tokens.token_type }),
              scopes,
            },
          },
        });
        tokensSaved = true;
        input.traces.append({
          traceId: begun.attempt.traceId,
          component: "google_oauth",
          event: "token_exchange_completed",
          outcome: "google",
          providerRequestId: requestIdFromHeaders(tokenResponse.res?.headers),
          data: { attemptId: begun.attempt.id, capabilities: googleCapabilities(scopes) },
        });
        const connection = finalizeGoogleConnection(input, saved);
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

function finalizeGoogleConnection(
  input: {
    attempts: OAuthAttemptStore;
    connections: ConnectionStore;
  },
  attempt: OAuthAttempt,
): ConnectionRecord {
  const saved = savedContextSchema.parse(attempt.context);
  const connection = input.connections.saveAuthorization({
    traceId: attempt.traceId,
    provider: "google",
    providerAccountId: saved.providerAccountId,
    safeLabel: saved.safeLabel,
    safeMetadata: saved.safeMetadata,
    providerState: saved.providerState,
    capabilities: saved.capabilities,
    credentials: saved.credentials,
    ...(attempt.expectedConnectionId === null
      ? {}
      : { expectedConnectionId: attempt.expectedConnectionId }),
    ...(saved.credentials.expiryDateMs === undefined
      ? {}
      : { expiresAtMs: saved.credentials.expiryDateMs }),
  });
  input.attempts.activate({ attemptId: attempt.id, connectionId: connection.id });
  return connection;
}

export function createGoogleOAuthClient(
  config: RuntimeConfig,
  endpoints?: Auth.OAuth2ClientOptions["endpoints"],
): Auth.OAuth2Client {
  const client = new Auth.OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.callbackUrl,
    ...(endpoints === undefined ? {} : { endpoints }),
  });
  client.transporter.interceptors.request.add({
    resolved: async (request) => ({
      ...request,
      retry: false,
      retryConfig: {
        ...request.retryConfig,
        retry: 0,
        noResponseRetries: 0,
      },
    }),
  });
  return client;
}

async function actualGoogleScopes(
  oauth: Auth.OAuth2Client,
  tokenScopes: string | null | undefined,
  accessToken: string | null | undefined,
): Promise<readonly string[]> {
  if (tokenScopes !== undefined && tokenScopes !== null) {
    return uniqueScopes(tokenScopes.split(/\s+/u));
  }
  if (accessToken === undefined || accessToken === null) {
    return [];
  }
  const info = await oauth.getTokenInfo(accessToken);
  return uniqueScopes(info.scopes);
}

export function googleCapabilities(scopes: readonly string[]): readonly ToolCapability[] {
  const grants = new Set(scopes);
  const full = grants.has("https://mail.google.com/");
  const readable =
    full ||
    grants.has("https://www.googleapis.com/auth/gmail.readonly") ||
    grants.has("https://www.googleapis.com/auth/gmail.modify");
  const composable =
    full ||
    grants.has("https://www.googleapis.com/auth/gmail.compose") ||
    grants.has("https://www.googleapis.com/auth/gmail.modify");
  return [
    ...(readable ? (["gmail.search", "gmail.read_thread"] as const) : []),
    ...(composable ? (["gmail.create_draft", "gmail.send_draft"] as const) : []),
  ];
}

function existingOrNewRefreshToken(
  connections: ConnectionStore,
  providerAccountId: string,
  expectedConnectionId: ConnectionId | null,
  newRefreshToken: string | null | undefined,
): string {
  if (newRefreshToken !== undefined && newRefreshToken !== null) {
    return newRefreshToken;
  }
  const existing = connections
    .list("google")
    .find(
      (connection) =>
        connection.providerAccountId === providerAccountId &&
        (expectedConnectionId === null || connection.id === expectedConnectionId),
    );
  if (existing !== undefined) {
    const credentials = credentialSchema.safeParse(connections.loadCredentials(existing.id));
    if (credentials.success) {
      return credentials.data.refreshToken;
    }
  }
  throw new Error("Google did not return a refresh token; authorize again with consent");
}

function uniqueScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function requestIdFromHeaders(headers: unknown): string | undefined {
  if (headers === null || typeof headers !== "object") {
    return undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record["x-request-id"] ?? record["x-guploader-uploadid"];
  return typeof value === "string" ? value : undefined;
}

function connectErrorPage(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ConnectLinkError || error instanceof OAuthAttemptError) {
    const status = error.code === "expired" || error.code === "used" ? 410 : 400;
    return sendOAuthPage(reply, status, "Connection link unavailable", error.message);
  }
  return sendOAuthPage(reply, 500, "Google connection failed", "Request a new link in iMessage.");
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
      "Wrong Google account",
      "Use the same Google account that this reconnection link was issued for.",
    );
  }
  if (error instanceof OAuthAttemptError) {
    return sendOAuthPage(reply, error.code === "expired" ? 410 : 400, "Authorization unavailable", error.message);
  }
  if (error instanceof z.ZodError) {
    return sendOAuthPage(reply, 400, "Invalid Google callback", "Request a new link in iMessage.");
  }
  return sendOAuthPage(
    reply,
    502,
    "Google connection needs attention",
    tokensSaved
      ? "The authorization is saved. Reload this page once to finish account setup."
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
    "Google is connected",
    `${connection.safeLabel} is ready. You can close this window.`,
  );
}
