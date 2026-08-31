# Production operations

## Deploy to Railway

Run exactly one application replica. The assistant serializes each chat through SQLite, and its WAL database, queue, memory document, OAuth credentials, and trace spool must share one local filesystem.

Prepare the Sendblue Free Sandbox before the first deploy:

1. In Sendblue, verify the assistant user's phone number as a contact of the sandbox line.
2. From that verified number, send one iMessage to the sandbox line so the conversation exists. The sandbox does not accept an outbound message into a conversation the contact has not opened.
3. Record the sandbox line number as `SENDBLUE_FROM_NUMBER`, the verified contact as `USER_PHONE_NUMBER`, and the API key pair as `SENDBLUE_API_KEY_ID` and `SENDBLUE_API_SECRET_KEY`. Both numbers are E.164.

Then deploy:

1. Create a Railway service from this repository. Railway detects and builds the root `Dockerfile`.
2. In the service deployment settings, keep one replica, set the health-check path to `/health` with a 30-second timeout, and use the `ON_FAILURE` restart policy with five retries. The image already starts `node dist/main.js`.
3. Add a persistent volume mounted at `/app/data`.
4. Do not set `RAILWAY_VOLUME_MOUNT_PATH`, `DATA_DIR`, or `RAILWAY_RUN_UID`. Railway automatically provides the mount path, and the image starts as root only long enough to prepare the volume before dropping to `node`.
5. Assign a public HTTPS domain and set `PUBLIC_BASE_URL` to its origin, without a trailing path.
6. Register `https://<domain>/oauth/google/callback` as an authorized Google OAuth redirect URI.
7. Confirm that Notion can reach these endpoints:
   - `https://<domain>/.well-known/notion-mcp-client.json`
   - `https://<domain>/oauth/notion/callback`
8. To send the daily brief, set `DAILY_BRIEF_ENABLED=true`. The schedule is fixed at 08:00 America/Los_Angeles.
9. Deploy. Railway considers the service healthy only after `GET /health` returns HTTP 200.

The HTTP process serves health checks and browser OAuth flows. Messaging needs no public URL, webhook route, external cron, or inbound network path. The receiver polls Sendblue, and the daily brief scheduler writes future work to the same durable queue.

Startup does not contact Sendblue, Google Workspace, Notion, or Gemini. An unhealthy provider connection cannot prevent the process from becoming ready. Startup validates configuration, migrates SQLite, repairs interrupted memory and write state, projects pending traces, and applies trace retention. The scheduler can insert the next daily brief job without contacting a provider.

The process handles `SIGTERM` by failing health checks, closing the HTTP listener, and stopping the receiver, the scheduler, and the worker after in-flight work returns. It then projects remaining trace events and closes SQLite.

## Connect Gmail and Notion accounts

One configured Google OAuth application and client ID can connect every Google account; the service stores and routes each account as a separate connection. If the OAuth app has an **External** user type and a **Testing** publishing status, open **Google Auth platform** > **Audience**. Add every account under **Test users** before starting OAuth. See [Configure the OAuth consent screen and choose scopes](https://developers.google.com/workspace/guides/configure-oauth-consent).

Connect accounts from iMessage:

1. Send `connect google` or `connect gmail` once for each Google account. Choose a different Google account in each browser flow.
2. Send `connect notion` once for each Notion workspace. Notion does not need a static API key or integration token.
3. Send `connections` to list the safe labels, health states, and granted capabilities.

When multiple accounts grant the same capability, include the exact safe label in the request. If you request all accounts, the agent calls each healthy account separately. It never chooses one account silently.

Google refresh tokens expire after seven days when the app has an **External** user type, a **Testing** publishing status, and Gmail scopes. Reconnect each Google account every seven days until the app moves to production. See [Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Run the daily brief

Set `DAILY_BRIEF_ENABLED=true` to schedule one brief at 08:00 America/Los_Angeles.

The scheduler stores at most one `daily_brief` job for each local date and maintains the current or next eligible date. A restart or overlapping scheduler pass resolves to the same date-keyed job. If the service returns within two hours after 08:00 and no job exists for that date, it sends a late brief. After that window, it schedules the next day. A persisted older job is skipped before provider work.

The scheduled run can use only `gmail.search`, `gmail.read_thread`, `notion.search`, and `notion.fetch`. It checks every healthy capable account by exact safe label. If no source is ready, the message gives the `connect google`, `connect notion`, and `connections` commands instead.

A prepared daily message carries its own durable expiry. The send boundary cancels it without contacting Sendblue if the completion window has elapsed or `DAILY_BRIEF_ENABLED` was changed to `false`. An already attempted or ambiguous send is never canceled or replayed.

## Sandbox operating limits

The Free Sandbox constrains day-to-day operation:

- The line is shared and assigned by Sendblue, and it exchanges messages only with contacts verified in Sendblue. A message from any other number is rejected at ingress.
- The verified contact must open the conversation. If the assistant has never received a message from `USER_PHONE_NUMBER`, treat a send failure as expected until the user texts the line.
- Inbound latency is bounded by the 5-second sweep. The event stream shortens it when connected but is never required; a stream outage degrades latency, not delivery.
- Sendblue does not transcribe audio. A voice note or media-only message answers with one `missing_text` failure notice instead of an agent run.
- Sendblue rate limits and HTTP 429 responses surface as transient sweep failures. The receiver honors `Retry-After`, so a throttled sweep retries instead of skipping messages.

## Monitor ingress

The receiver writes its own traces. `sendblue_poll` events cover `receiver_started`, `page_attempted`, `page_completed`, and `sweep_failed`; `sendblue_stream` events cover stream connection and failure. A poll trace rotates every 15 minutes or 1,800 events, so a healthy service produces a steady series of short terminal poll traces.

Repeated `sweep_failed` events with no `page_completed` mean ingress is stopped: no message can reach the queue until it recovers. A terminal sweep failure stops the background actors and the process exits non-zero so Railway restarts it.

## Cutover from the retired webhook transport

Migration 4 performs the one-time Messages.dev cutover when an existing database first opens on this build. It creates the ingress cursor, blocks every pending voice-poll job and inbound message that was waiting on a transcription, and resolves in-flight egress by state: `prepared` becomes `provider_failed`, `attempting` becomes `acceptance_unknown`, and `accepted` or `sent` becomes `delivery_unknown`. Their jobs are blocked and their write intents become `confirmed_failed` or `ambiguous`.

Nothing from the old transport is replayed. Review the blocked rows by trace ID, and ask the user to resend anything that mattered rather than re-sending an ambiguous message.

## Persistent state and backups

The `/app/data` volume contains:

- `assistant.sqlite`, `assistant.sqlite-wal`, and `assistant.sqlite-shm`
- `MEMORY.md`
- exported JSONL traces under `traces/`

Use a Railway volume snapshot while the service is stopped for a consistent file-level backup. The SQLite database is authoritative for queue and trace state. JSONL trace files are repairable projections, not the source of truth.

Keep `TRACE_RETENTION_DAYS` and `TRACE_MAX_BYTES` within the volume capacity. Cleanup deletes only terminal traces already exported to JSONL.

## Inspect and replay a trace

Render the durable chronology:

```sh
pnpm trace -- <trace-id>
```

Run a deterministic, read-only replay from captured model and tool results:

```sh
pnpm replay -- <trace-id>
```

Replay does not load the credential encryption key, decrypt connection credentials, contact providers, or execute tools.

## Rotate credentials

Rotate one provider credential at a time. Keep the service at one replica throughout the procedure.

### Sendblue API key pair

`SENDBLUE_API_KEY_ID` and `SENDBLUE_API_SECRET_KEY` authenticate every list, stream, send, and status call. Rotate them together:

1. Create the replacement key pair in Sendblue.
2. Replace both variables in Railway and redeploy.
3. Text the line from `USER_PHONE_NUMBER` and confirm the trace shows a completed sweep and an `egress delivered` reply.
4. Revoke the previous key pair.

A rotation restart is safe. The ingress cursor is durable, and the sweep after restart re-reads a 60-second overlap window, so messages that arrived during the redeploy are still ingested exactly once.

### Sendblue line or verified contact

Changing `SENDBLUE_FROM_NUMBER` or `USER_PHONE_NUMBER` changes the trusted identities, so it is a cutover, not a rotation:

1. Verify the new contact or claim the new line in Sendblue.
2. Text the line from the new number to create the conversation.
3. Replace the variable in Railway and redeploy.
4. Wait until the new deployment is ready.
5. Text the line again and confirm one accepted inbound trace.

The predeployment message can be older than the cursor overlap. Do not use that message as the smoke test.

### Gemini API key

1. Create a replacement Gemini Developer API key in Google AI Studio.
2. Replace `GEMINI_API_KEY` in Railway and redeploy.
3. Send a read-only request and inspect its trace.
4. Revoke the previous key.

### Google OAuth client secret

1. Create or reset the Google OAuth client secret without changing its client ID or redirect URI.
2. Replace `GOOGLE_CLIENT_SECRET` in Railway and redeploy.
3. Existing refresh tokens continue to work when Google preserves the OAuth client. If Google invalidates them, the assistant sends one signed reconnect link per affected connection.
4. Complete each reconnect in a browser and then revoke the old secret.

### Credential encryption key

`CREDENTIAL_ENCRYPTION_KEY` encrypts every stored provider credential with AES-256-GCM. Replacing it without re-encrypting the database makes existing credentials unreadable. This repository intentionally has no online rewrap command.

Use this destructive rotation procedure only during a maintenance window:

1. Stop the service and take a volume snapshot.
2. Preserve any needed `MEMORY.md` and exported traces outside the volume.
3. Replace the persistent volume with an empty volume mounted at `/app/data`.
4. Generate a new key with `openssl rand -base64 32` and replace `CREDENTIAL_ENCRYPTION_KEY`.
5. Deploy, then reconnect every Google account and Notion workspace through the assistant.
6. Retain the encrypted backup until the reconnections are verified; protect its old encryption key with the same controls as the backup.

Never rotate this key by editing only the environment variable.
