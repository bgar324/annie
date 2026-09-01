# Ben

Ben is a single-user personal assistant that lives in iMessage. It receives messages through a Sendblue Free Sandbox line, runs a bounded TypeScript agent loop, and exposes eight narrow tools for Gmail, Google Workspace, Notion, and account connections.

This is deliberately not a general-purpose bot framework. It is built around one trusted sender, one assistant line, durable local state, and conservative provider-write semantics.

## What Ben can do

- Read Gmail, calendars, Drive, contacts, and tasks from connected Google accounts.
- Search and fetch content from connected Notion workspaces.
- Create Gmail drafts, send an explicit draft, create one Notion page, or narrowly update a Notion page when the current request authorizes the write.
- Connect multiple Google accounts and a Notion workspace through signed OAuth links.
- Send an optional read-only morning brief at 08:00 America/Los_Angeles.
- Maintain one bounded `MEMORY.md` document for durable user preferences.
- Render every run as a redacted, replayable trace.

Ben cannot delete, archive, move, or invoke arbitrary provider methods.

## Safety model

The service controls real messaging and productivity accounts, so its safety rules are part of the architecture:

- An inbound message must match both the configured Sendblue line and trusted sender.
- Paged polling is authoritative ingress. The event stream only wakes the poller early.
- Accepted messages, jobs, delivery state, and traces are committed durably in SQLite.
- Network calls never run inside SQLite transactions.
- Every external request gets a durable trace attempt first.
- Every provider mutation gets a durable write intent before dispatch.
- An ambiguous provider write is never retried automatically.
- Provider credentials, wire payloads, account IDs, and SDK clients never enter the model context.
- The production registry stays fixed at eight tools.

See [Architecture](docs/architecture.md) for the complete invariants and crash semantics.

## Runtime shape

```text
iMessage
   │
   ▼
Sendblue polling receiver ── SSE wake hint
   │
   ▼
SQLite ingress + durable queue
   │
   ▼
Bounded agent loop
   ├── Gmail and Google Workspace adapters
   ├── Notion hosted MCP adapter
   ├── connection and OAuth services
   └── write-intent state machine
   │
   ▼
Sendblue egress + delivery reconciliation
```

One Node.js process owns one long-lived `better-sqlite3` connection in WAL mode. Production must run exactly one replica with one persistent filesystem.

## Requirements

- Node.js 24
- pnpm 11
- A Sendblue Free Sandbox account and iMessage line
- An OpenAI-compatible chat-completions API key
- A Google OAuth web application
- A public HTTPS origin for OAuth callbacks outside local development
- A persistent local directory or Railway volume

Notion uses the hosted MCP service and CIMD. It does not require a static Notion API key, integration token, client ID, or client secret.

## Quick start

```sh
git clone https://github.com/bgar324/ben.git
cd ben
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
```

Put the generated value in `CREDENTIAL_ENCRYPTION_KEY`, then fill the remaining required values in `.env`. Never commit that file.

Start the development process:

```sh
pnpm dev
```

The Sendblue sandbox requires one setup message before Ben can reply: verify `USER_PHONE_NUMBER` as a contact, then text `SENDBLUE_FROM_NUMBER` from that number once.

For OAuth setup and the first end-to-end message, follow [Local development](docs/local-development.md).

## Configuration

The complete template is [.env.example](.env.example). The main groups are:

| Variables | Purpose |
| --- | --- |
| `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY` | Authenticate Sendblue reads and sends |
| `SENDBLUE_FROM_NUMBER`, `USER_PHONE_NUMBER` | Define the exact assistant line and trusted sender |
| `PUBLIC_BASE_URL` | Build Google and Notion OAuth callback URLs |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL` | Configure the OpenAI-compatible model endpoint |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Run Google OAuth for connected accounts |
| `NOTION_MCP_URL` | Select the hosted Notion MCP endpoint |
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypt provider credentials with AES-256-GCM |
| `DAILY_BRIEF_ENABLED` | Enable the optional scheduled morning brief |
| `RAILWAY_VOLUME_MOUNT_PATH` or `DATA_DIR` | Place SQLite, traces, and memory on persistent storage |

`.env`, SQLite files, traces, `data/`, and build output are ignored by Git. Keep them out of commits and bug reports.

## Commands

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm trace -- <trace-id>
pnpm replay -- <trace-id>
```

Tests use temporary databases, synthetic phone numbers, and provider doubles. They never call live provider write endpoints.

## Deployment

The repository includes a multi-stage [Dockerfile](Dockerfile). Railway should run one replica with one volume mounted at `/app/data`; the container starts `node dist/main.js` and handles `SIGTERM` directly.

Read [Production operations](docs/operations.md) before deploying, rotating credentials, restoring state, or changing the Sendblue line.

## Documentation

- [Architecture and failure semantics](docs/architecture.md)
- [Local development](docs/local-development.md)
- [Production operations](docs/operations.md)
