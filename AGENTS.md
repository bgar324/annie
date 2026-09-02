# Repository instructions

## Read this first

This service controls real Google Workspace, Notion, and iMessage accounts. Preserve these rules in every change:

- Accept an inbound message only when it names the exact Sendblue line (`SENDBLUE_FROM_NUMBER`) and the exact trusted sender (`USER_PHONE_NUMBER`) on both of their reported fields.
- Treat the paged inbound list sweep as the authoritative ingress path. The event stream is a latency hint only; never let a stream event become the source of a message.
- Commit the delivery row, inbound row, trace events, and job in one SQLite transaction, and advance the durable ingress cursor only from committed rows.
- Keep every network call outside SQLite transactions.
- Commit a trace attempt before each external request.
- Commit a write intent in `attempting` before each provider mutation.
- Never retry or replay an ambiguous provider write.
- Never expose provider SDK clients, wire payloads, tokens, connection IDs, or provider account IDs to the model.
- Select an account only by one exact safe label or one unambiguous healthy capable connection.
- Treat healthy capable accounts as one logical source for unscoped reads. Enumerate exact safe labels, call each account separately, and merge the results. Deduplicate the same underlying item across accounts without collapsing distinct items that share a title. Never ask the user to choose an account only because several are connected. Keep writes single-account and ask only when the target cannot be inferred safely.
- Change only the affected connection's health.
- Keep `MEMORY.md` as the only canonical long-term memory file.
- Keep the production registry at exactly eight tools. Do not expose destructive or catch-all provider methods.
- Run daily briefs through the same eight-tool production registry, but expose and enforce only `gmail.search`, `gmail.read_thread`, `google.search`, `google.read`, `notion.search`, and `notion.fetch` for that run.
- Skip daily brief work outside its same-morning window, and cancel only still-prepared daily egress when it expires or the feature is disabled.

The architecture rationale and failure semantics live in `docs/architecture.md`.

## Commands

Run these from the repository root:

```text
pnpm typecheck
pnpm test
pnpm build
pnpm trace -- <trace-id>
pnpm replay -- <trace-id>
```

Use Node 24. Railway starts `node dist/main.js` directly so the process receives `SIGTERM`.

## Code ownership

- `src/runtime.ts`: process composition, the Fastify instance, `/health`, and job-handler wiring.
- `src/messages`: the Sendblue gateway, the polling receiver, ingress matching and normalization, inbound and daily brief turns, egress, and delivery reconciliation.
- `src/db`: the one SQLite connection, schema migrations, and local integrity checks.
- `src/queue`: lease claims, heartbeats, ordering, and recovery.
- `src/tracing`: redaction, durable trace spool, JSONL projection, and rendering.
- `src/connections`: safe metadata, capability routing, and health transitions.
- `src/oauth`: signed links, durable OAuth attempts, PKCE flows, refresh, and recovery notices.
- `src/security`: AES-256-GCM credential encryption.
- `src/core` and `src/providers`: shared identifiers, canonical JSON, error types, and the traced timeout-bounded fetch used by provider adapters.
- `src/writes`: write-intent preparation, attempt records, and ambiguous-write recovery.
- `src/agent`: provider-neutral messages, Gemini wire mapping, bounds, and the fixed tool registry.
- `src/gmail`, `src/google`, and `src/notion`: the only provider tool adapters.
- `src/memory`: bounded load, maintenance validation, diff, and atomic replacement.

Provider wire types stay inside their adapter. Core code consumes normalized application types.

## SQLite rules

Use the long-lived `better-sqlite3` connection from `src/db/database.ts`. The database runs in WAL mode with `synchronous=FULL`, foreign keys enabled, and STRICT tables.

Use a short synchronous transaction for each state change. Do not pass an async function to `db.transaction()`. Every lease mutation checks `lease_token`. Every credential mutation checks `credential_generation`. Use UPSERT for uniqueness conflicts. Do not use `INSERT OR IGNORE`, because it hides malformed rows.

A job is at least once. A provider mutation is not. If the process may have issued a write, record `ambiguous` and stop automatic execution.

## Provider rules

### Sendblue

Pin `sendblue@3.16.1` with `maxRetries: 0` and route every call through `SendblueGateway`. The gateway validates each response with an application Zod codec and normalizes failures into `MessagingProviderError` with kind `terminal`, `transient`, or `ambiguous`. A failed write is `ambiguous` unless the provider confirmed the failure.

Inbound listing is filtered server-side to the trusted sender, the configured line, inbound direction, one-to-one iMessage, and `RECEIVED` status, and is ordered by `updatedAt` ascending. The receiver still re-checks every field locally before accepting. Sendblue does not transcribe inbound audio, so there is no voice path: a message without text reaches `missing_text` handling.

### Gemini

Use `gemini-3.7-flash` through Google's OpenAI-compatible `/chat/completions`. Tool wire names use underscores; internal names use dots. Preserve each returned assistant wire message as opaque provider state and replay it unchanged before tool results so Gemini thought signatures survive. Use low reasoning by default and omit `tool_choice`.

### Google

Create one OAuth client per connection. Key accounts by verified OIDC `sub`, not email. Request the fixed read-only Gmail, Calendar, Drive, Contacts, and Tasks scope bundle, reject partial or broader grants, and derive semantic capabilities from the actual granted scopes. Disable Google SDK retries; trace and bound application-owned read retries. Keep provider resource types and raw payloads inside `src/gmail` and `src/google`.

### Notion

Use hosted Streamable HTTP and CIMD. Intersect the four exact upstream names with all `listTools()` pages and `current_tool_access`. Force `query_type: "internal"`. Wrap create as one page. Validate each call against its live input schema, and reject an incompatible write before preparing its write intent or dispatching it. Schema changes and tool availability failures do not change connection health or require reconnection.

## Tests

Test observable contracts and crash boundaries. Use temporary directories and SQLite files. Inject provider doubles at adapter boundaries, including the `MessageGateway` used by the receiver and egress. Fixtures must use synthetic E.164 numbers and test secrets.

Required regression cases include:

- repeated provider message IDs across overlapping sweeps;
- rejected line, sender, group, service, and status values;
- cursor overlap and durable cursor advancement across restart;
- media-only inbound reaching `missing_text` without an agent run;
- lease expiry with stale-token fencing;
- persisted jobs after restart;
- daily brief 08:00 scheduling across DST, restart, stale-job recovery, and exhausted leases;
- daily brief six-tool read-only enforcement, per-account product coverage, and stale or disabled egress cancellation;
- exact per-call account selection and automatic multi-account read coverage;
- reconnect identity mismatch;
- expired and completed signed links;
- refresh generation races;
- write ambiguity without replay;
- Gmail, Calendar, Drive, Contacts, Tasks, and Notion read normalization;
- explicit write-intent gates;
- memory atomicity and diff tracing;
- trace redaction and JSONL repair;
- replay with mock tools only.

Do not call live provider write endpoints from tests.

## Clean changes

Migrate every caller in the same change. Delete obsolete names and paths. Do not add compatibility aliases, generic provider frameworks, controller hierarchies, or pass-through wrappers. Add a dependency only when a maintained library is safer than local protocol code.