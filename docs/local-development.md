# Local development

## Prerequisites

Install Node.js 24 and pnpm 11. Create `.env` from `.env.example`.

Messaging needs a Sendblue Free Sandbox account and two E.164 numbers:

- `SENDBLUE_FROM_NUMBER` is the sandbox line.
- `USER_PHONE_NUMBER` is your own number, verified as a contact of that line in Sendblue.

Text the sandbox line once from the verified number before starting the assistant. The line only exchanges messages with a verified contact who opened the conversation.

Run one instance at a time against a sandbox line. Each instance keeps its own ingress cursor, so two instances on the same line both ingest and answer the same messages.

Use `PUBLIC_BASE_URL=http://localhost:3000`. Messaging never needs a public URL; the value is used for the signed connection links and OAuth callbacks. Google and Notion must also allow the callback URLs shown in `.env.example` before local OAuth can finish.

## Start the assistant

```sh
pnpm install
pnpm dev
```

The process opens SQLite and `MEMORY.md` under `DATA_DIR`, listens on port 3000 by default, and then starts the durable worker and the Sendblue receiver. Startup fails instead of using ephemeral storage when production volume configuration is missing or invalid. Startup contacts no provider, so a bad Sendblue key surfaces on the first sweep, not at boot.

## Send a message through the loop

There is nothing to forward and no tunnel to run. The receiver polls Sendblue every 5 seconds and resumes early when the event stream reports activity.

Text the sandbox line from `USER_PHONE_NUMBER`. Expected flow:

1. The sweep lists inbound messages from the durable cursor, minus a 60-second overlap.
2. Ingress requires the exact line on both reported line fields and the exact sender on both reported sender fields, one-to-one `iMessage` with status `RECEIVED`; it rejects everything else before enqueueing work.
3. The delivery, inbound message, trace events, and job commit in one SQLite transaction, and only then does the cursor advance.
4. The worker claims one job for that chat and sends the reply from `SENDBLUE_FROM_NUMBER`.
5. If the send response does not already report delivery, bounded status polls resolve it. An unacknowledged send is never sent twice.

Re-observing a message in the overlap window is normal and creates no second inbound message, job, or agent run.

A message with media but no text is blocked and answered with one `missing_text` failure notice, because Sendblue returns no inbound transcription.

## Inspect a run

The iMessage failure response includes a trace ID. Render its durable chronology with:

```sh
pnpm trace -- <trace-id>
```

JSONL traces are projections of the SQLite trace spool. If a process stops during projection, startup repairs the file from SQLite.

## Run local checks

```sh
pnpm typecheck
pnpm test
pnpm build
```
