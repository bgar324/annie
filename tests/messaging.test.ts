import { getEventListeners } from "node:events";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import { newTraceId, type EgressId, type TraceId, type WriteIntentId } from "../src/core/ids.js";
import { openDatabase } from "../src/db/database.js";
import { SendblueGateway } from "../src/messages/client.js";
import { MessageEgressService } from "../src/messages/egress.js";
import { FailureNotificationService } from "../src/messages/failure.js";
import { MessageIngressService } from "../src/messages/inbound.js";
import { SendblueReceiver } from "../src/messages/receiver.js";
import {
  MessagingProviderError,
  type DeliveryResource,
  type InboundMessage,
  type InboundPage,
  type InboundWakeStream,
  type MessageGateway,
} from "../src/messages/types.js";
import { QueueCapacityError, QueueStore, type ClaimedJob } from "../src/queue/store.js";
import { DurableWorker } from "../src/queue/worker.js";
import { TraceProjector } from "../src/tracing/jsonl.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";
import { WriteStore, type WriteIntent } from "../src/writes/store.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

const trustedSender = "+15559990000";
const sendblueLine = "+15551112222";
const pageSize = 100;
const recoveryOverlapMs = 60_000;

interface MessagingHarness {
  config: RuntimeConfig;
  database: TestDatabase;
  queue: QueueStore;
  traces: TraceStore;
  projector: TraceProjector;
  writes: WriteStore;
  gateway: FakeSendblueGateway;
  ingress: MessageIngressService;
  egress: MessageEgressService;
  receivers: SendblueReceiver[];
}

class FakeSendblueGateway implements MessageGateway {
  inbox: InboundMessage[] = [];
  maxPageSize = pageSize;
  listError: MessagingProviderError | undefined;
  wakeEventCount = 0;
  streamOpens = 0;
  sendHandle = "msg_handle_1";
  sendStatus: DeliveryResource["status"] = "pending";
  sendError: MessagingProviderError | undefined;
  statuses: DeliveryResource["status"][] = [];
  statusError: MessagingProviderError | undefined;
  readonly listRequests: { updatedAtGteMs: number; limit: number; offset: number }[] = [];
  readonly sendRequests: { to: string; text: string; replyTo?: string }[] = [];
  readonly statusRequests: string[] = [];
  #listWaiters: { count: number; resolve: () => void }[] = [];

  listedAtLeast(count: number): Promise<void> {
    if (this.listRequests.length >= count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#listWaiters.push({ count, resolve });
    });
  }

  async listInbound(input: {
    updatedAtGteMs: number;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }): Promise<InboundPage> {
    this.listRequests.push({
      updatedAtGteMs: input.updatedAtGteMs,
      limit: input.limit,
      offset: input.offset,
    });
    this.#listWaiters = this.#listWaiters.filter((waiter) => {
      if (this.listRequests.length < waiter.count) {
        return true;
      }
      waiter.resolve();
      return false;
    });
    if (this.listError !== undefined) {
      throw this.listError;
    }
    const visible = this.inbox
      .filter((message) => message.updatedAtMs >= input.updatedAtGteMs)
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs);
    return {
      messages: visible.slice(input.offset, input.offset + Math.min(input.limit, this.maxPageSize)),
      total: visible.length,
      requestId: `req_list_${this.listRequests.length}`,
    };
  }

  async openInboundWakeStream(signal: AbortSignal): Promise<InboundWakeStream> {
    this.streamOpens += 1;
    return {
      events: wakeEvents(this.wakeEventCount, signal),
      requestId: `req_stream_${this.streamOpens}`,
    };
  }

  async send(input: { to: string; text: string; replyTo?: string }): Promise<DeliveryResource> {
    this.sendRequests.push({
      to: input.to,
      text: input.text,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    });
    if (this.sendError !== undefined) {
      throw this.sendError;
    }
    return {
      messageHandle: this.sendHandle,
      status: this.sendStatus,
      requestId: `req_send_${this.sendRequests.length}`,
      error: null,
    };
  }

  async getStatus(messageHandle: string): Promise<DeliveryResource> {
    this.statusRequests.push(messageHandle);
    if (this.statusError !== undefined) {
      throw this.statusError;
    }
    const status = this.statuses.shift() ?? "pending";
    return {
      messageHandle,
      status,
      requestId: `req_status_${this.statusRequests.length}`,
      error: status === "failed" ? "Sendblue delivery failed" : null,
    };
  }
}

async function* wakeEvents(count: number, signal: AbortSignal): AsyncGenerator<void> {
  for (let index = 0; index < count; index += 1) {
    if (signal.aborted) {
      return;
    }
    yield undefined;
  }
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const harnesses: MessagingHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    for (const receiver of harness.receivers.splice(0)) {
      receiver.close();
    }
    harness.database.cleanup();
  }
});

describe("Sendblue inbound sweep", () => {
  it("baselines the durable cursor once and lists from it without overlap", async () => {
    const harness = createMessagingHarness();
    const baselineMs = Date.now();
    const receiver = createReceiver(harness);

    receiver.initialize(baselineMs);
    expect(cursorRow(harness)).toEqual({ updated_at_ms: baselineMs, recovered_once: 0 });

    await receiver.sweepOnce(new AbortController().signal);

    expect(harness.gateway.listRequests).toEqual([
      { updatedAtGteMs: baselineMs, limit: pageSize, offset: 0 },
    ]);
    expect(cursorRow(harness)).toEqual({ updated_at_ms: baselineMs, recovered_once: 1 });

    createReceiver(harness).initialize(baselineMs + 3_600_000);

    expect(cursorRow(harness).updated_at_ms).toBe(baselineMs);
  });

  it("ingests every page of the authoritative sweep and advances the cursor to its watermark", async () => {
    const harness = createMessagingHarness();
    const baselineMs = Date.now();
    harness.gateway.maxPageSize = 2;
    harness.gateway.inbox = [
      inboundMessage({ id: "msg_1", updatedAtMs: baselineMs + 1_000, text: "first" }),
      inboundMessage({ id: "msg_2", updatedAtMs: baselineMs + 2_000, text: "second" }),
      inboundMessage({ id: "msg_3", updatedAtMs: baselineMs + 3_000, text: "third" }),
    ];
    const receiver = createReceiver(harness);
    receiver.initialize(baselineMs);

    await receiver.sweepOnce(new AbortController().signal);

    expect(harness.gateway.listRequests.map((request) => request.offset)).toEqual([0, 2]);
    expect(inboundRows(harness).map((row) => [row.provider_message_id, row.text, row.sequence])).toEqual([
      ["msg_1", "first", 1],
      ["msg_2", "second", 2],
      ["msg_3", "third", 3],
    ]);
    expect(jobRows(harness).map((row) => row.type)).toEqual(["inbound", "inbound", "inbound"]);
    expect(cursorRow(harness).updated_at_ms).toBe(baselineMs + 3_000);
  });

  it("ingests a provider message once when the overlap sweep repeats it", async () => {
    const harness = createMessagingHarness();
    const baselineMs = Date.now();
    harness.gateway.inbox = [inboundMessage({ id: "msg_repeat", updatedAtMs: baselineMs + 1_000 })];
    const receiver = createReceiver(harness);
    receiver.initialize(baselineMs);

    await receiver.sweepOnce(new AbortController().signal);
    await receiver.sweepOnce(new AbortController().signal);

    expect(harness.gateway.listRequests.map((request) => request.updatedAtGteMs)).toEqual([
      baselineMs,
      baselineMs + 1_000 - recoveryOverlapMs,
    ]);
    expect(countRows(harness, "inbound_messages")).toBe(1);
    expect(countRows(harness, "jobs")).toBe(1);
    expect(
      spooledEvents(harness, "ingress").filter((event) => event.event === "duplicate"),
    ).toHaveLength(1);
  });

  it("catches up on a message the overlap window exposes after a restart", async () => {
    const harness = createMessagingHarness();
    const baselineMs = Date.now();
    harness.gateway.inbox = [inboundMessage({ id: "msg_live", updatedAtMs: baselineMs + 1_000 })];
    const before = createReceiver(harness);
    before.initialize(baselineMs);
    await before.sweepOnce(new AbortController().signal);
    before.close();

    harness.gateway.inbox.push(
      inboundMessage({ id: "msg_late", updatedAtMs: baselineMs + 1_000 - 30_000 }),
    );
    const after = createReceiver(harness);
    after.initialize(baselineMs + 900_000);
    await after.sweepOnce(new AbortController().signal);

    expect(harness.gateway.listRequests.at(-1)).toEqual({
      updatedAtGteMs: baselineMs + 1_000 - recoveryOverlapMs,
      limit: pageSize,
      offset: 0,
    });
    expect(inboundRows(harness).map((row) => row.provider_message_id)).toEqual([
      "msg_live",
      "msg_late",
    ]);
    expect(cursorRow(harness).updated_at_ms).toBe(baselineMs + 1_000);
  });

  it("treats a stream event as a wake hint that never becomes a message", async () => {
    const harness = createMessagingHarness();
    harness.gateway.wakeEventCount = 3;
    const receiver = createReceiver(harness);
    receiver.initialize(Date.now());
    const controller = new AbortController();

    const running = receiver.run(controller.signal);
    await harness.gateway.listedAtLeast(2);
    controller.abort();
    await running;

    expect(harness.gateway.streamOpens).toBe(1);
    expect(spooledEvents(harness, "sendblue_stream").map((event) => event.event)).toContain(
      "stream_opened",
    );
    expect(countRows(harness, "inbound_messages")).toBe(0);
    expect(countRows(harness, "webhook_deliveries")).toBe(0);
  });

  it("rejects any message that is not the exact trusted sender on the exact line", () => {
    const harness = createMessagingHarness();

    const results = [
      harness.ingress.ingest(
        inboundMessage({ id: "msg_alien_sender", senderNumber: "+15557778888" }),
      ),
      harness.ingress.ingest(
        inboundMessage({ id: "msg_spoofed_contact", contactNumber: "+15557778888" }),
      ),
      harness.ingress.ingest(inboundMessage({ id: "msg_alien_line", lineNumber: "+15553334444" })),
      harness.ingress.ingest(
        inboundMessage({ id: "msg_spoofed_recipient", recipientNumber: "+15553334444" }),
      ),
      harness.ingress.ingest(inboundMessage({ id: "msg_from_line", isOutbound: true })),
      harness.ingress.ingest(inboundMessage({ id: "msg_group", groupId: "grp_1" })),
      harness.ingress.ingest(inboundMessage({ id: "msg_sms", service: "SMS" })),
    ];

    expect(results.map((result) => [result.kind, "reason" in result ? result.reason : null])).toEqual([
      ["rejected", "sender_not_allowed"],
      ["rejected", "sender_not_allowed"],
      ["rejected", "line_not_allowed"],
      ["rejected", "line_not_allowed"],
      ["rejected", "message_from_assistant_line"],
      ["rejected", "group_not_allowed"],
      ["rejected", "service_not_allowed"],
    ]);
    expect(countRows(harness, "inbound_messages")).toBe(0);
    expect(countRows(harness, "jobs")).toBe(0);
    expect(countRows(harness, "webhook_deliveries")).toBe(7);
  });

  it("commits the delivery row, the inbound row, and its job together or not at all", () => {
    const harness = createMessagingHarness({ maxPending: 1 });
    harness.queue.enqueue({
      chatId: trustedSender,
      type: "inbound",
      subjectId: "in_filler",
      payload: {},
      traceId: newTraceId(),
      inboundSequence: 1,
    });

    expect(() => harness.ingress.ingest(inboundMessage({ id: "msg_capacity" }))).toThrow(
      QueueCapacityError,
    );

    expect(countRows(harness, "webhook_deliveries")).toBe(0);
    expect(countRows(harness, "inbound_messages")).toBe(0);
    expect(jobRows(harness).map((row) => row.subject_id)).toEqual(["in_filler"]);
    expect(spooledEvents(harness, "ingress")).toEqual([]);
  });

  it("queues a media-only message as ordinary inbound work with no text", () => {
    const harness = createMessagingHarness();

    const result = harness.ingress.ingest(
      inboundMessage({ id: "msg_media_only", text: null, hasMedia: true }),
    );

    expect(result.kind).toBe("accepted");
    const row = inboundRows(harness)[0];
    expect(row).toMatchObject({ state: "ready", text: null, is_audio: 0 });
    expect(JSON.parse(row?.attachment_json ?? "null")).toEqual({
      kind: "message",
      providerMessageId: "msg_media_only",
      sentAtMs: expect.any(Number),
      updatedAtMs: expect.any(Number),
      mediaAvailable: true,
    });
    expect(jobRows(harness).map((job) => job.type)).toEqual(["inbound"]);
  });
});

describe("Sendblue API requests", () => {
  it("authenticates every list with the key pair, the configured base URL, and server-side filters", async () => {
    const harness = createMessagingHarness();
    const calls: Request[] = [];
    const gateway = new SendblueGateway(
      harness.config,
      stubFetch(calls, () =>
        Response.json(
          {
            data: [wireMessage({ media_url: "https://cdn.sendblue.test/a.jpg" })],
            pagination: { limit: pageSize, offset: 0, total: 1 },
          },
          { headers: { "x-request-id": "req_list_1" } },
        ),
      ),
    );

    const page = await gateway.listInbound({
      updatedAtGteMs: 1_700_000_000_000,
      limit: pageSize,
      offset: 0,
      signal: new AbortController().signal,
    });

    expect(page).toMatchObject({ total: 1, requestId: "req_list_1" });
    expect(page.messages[0]).toEqual({
      id: "msg_wire_1",
      senderNumber: trustedSender,
      contactNumber: trustedSender,
      lineNumber: sendblueLine,
      recipientNumber: sendblueLine,
      text: "Hello",
      hasMedia: true,
      isOutbound: false,
      messageType: "message",
      groupId: null,
      service: "iMessage",
      status: "RECEIVED",
      sentAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_001_000,
      replyToId: null,
    });
    const request = requiredRequest(calls[0]);
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.sendblue.test/api/v2/messages");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from_number: trustedSender,
      is_outbound: "false",
      limit: String(pageSize),
      message_type: "message",
      offset: "0",
      order_by: "updatedAt",
      order_direction: "asc",
      sendblue_number: sendblueLine,
      service: "iMessage",
      status: "RECEIVED",
      updated_at_gte: new Date(1_700_000_000_000).toISOString(),
    });
    expect(request.headers.get("sb-api-key-id")).toBe("sb_test_key_id");
    expect(request.headers.get("sb-api-secret-key")).toBe("sb_test_secret_key");
  });

  it("opens an authenticated message-received event stream as a wake hint", async () => {
    const harness = createMessagingHarness();
    const calls: Request[] = [];
    const gateway = new SendblueGateway(
      harness.config,
      stubFetch(
        calls,
        () =>
          new Response(
            `data: ${JSON.stringify({
              id: "event_1",
              type: "message.received",
              occurred_at: new Date(1_700_000_000_000).toISOString(),
              version: 1,
              data: { message_handle: "msg_1" },
            })}\n\n`,
            {
              headers: {
                "content-type": "text/event-stream",
                "x-request-id": "req_stream_1",
              },
            },
          ),
      ),
    );

    const stream = await gateway.openInboundWakeStream(new AbortController().signal);
    const wakes: void[] = [];
    for await (const wake of stream.events) {
      wakes.push(wake);
    }

    expect(wakes).toEqual([undefined]);
    expect(stream.requestId).toBe("req_stream_1");
    const request = requiredRequest(calls[0]);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/v2/events");
    expect(url.searchParams.get("types")).toBe("message.received");
    expect(request.headers.get("accept")).toBe("text/event-stream");
    expect(request.headers.get("sb-api-key-id")).toBe("sb_test_key_id");
    expect(request.headers.get("sb-api-secret-key")).toBe("sb_test_secret_key");
  });

  it("refuses a list page whose pagination contradicts the request", async () => {
    const harness = createMessagingHarness();
    const gateway = new SendblueGateway(harness.config, stubFetch([], () =>
      Response.json({
        data: [wireMessage()],
        pagination: { limit: pageSize, offset: 7, total: 1 },
      }),
    ));

    await expect(
      gateway.listInbound({
        updatedAtGteMs: 0,
        limit: pageSize,
        offset: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: "MessagingProviderError",
      kind: "terminal",
      message: "Sendblue returned an invalid response",
    });
  });

  it("refuses a list row that fails the runtime response codec", async () => {
    const harness = createMessagingHarness();
    const incomplete = wireMessage();
    delete incomplete.sendblue_number;
    const gateway = new SendblueGateway(harness.config, stubFetch([], () =>
      Response.json({
        data: [incomplete],
        pagination: { limit: pageSize, offset: 0, total: 1 },
      }),
    ));

    await expect(
      gateway.listInbound({
        updatedAtGteMs: 0,
        limit: pageSize,
        offset: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "MessagingProviderError", kind: "terminal" });
  });

  it("posts one send from the configured line with its reply context", async () => {
    const harness = createMessagingHarness();
    const calls: Request[] = [];
    const gateway = new SendblueGateway(
      harness.config,
      stubFetch(calls, () =>
        Response.json(
          { message_handle: "msg_sent_1", status: "QUEUED" },
          { headers: { "sb-request-id": "req_send_1" } },
        ),
      ),
    );

    const delivery = await gateway.send({
      to: trustedSender,
      text: "On my way.",
      replyTo: "msg_inbound_1",
    });

    expect(delivery).toEqual({
      messageHandle: "msg_sent_1",
      status: "pending",
      requestId: "req_send_1",
      error: null,
    });
    expect(calls).toHaveLength(1);
    const request = requiredRequest(calls[0]);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/send-message");
    expect(JSON.parse(await request.text())).toEqual({
      from_number: sendblueLine,
      number: trustedSender,
      content: "On my way.",
      reply_to: { message_handle: "msg_inbound_1" },
    });
  });

  it("classifies an unconfirmed send failure as ambiguous after exactly one attempt", async () => {
    const harness = createMessagingHarness();
    const calls: Request[] = [];
    const gateway = new SendblueGateway(
      harness.config,
      stubFetch(calls, () =>
        Response.json(
          { error: "upstream unavailable" },
          { status: 500, headers: { "sb-request-id": "req_send_failed" } },
        ),
      ),
    );

    await expect(gateway.send({ to: trustedSender, text: "Possibly sent." })).rejects.toMatchObject({
      name: "MessagingProviderError",
      kind: "ambiguous",
      status: 500,
      requestId: "req_send_failed",
    });

    expect(calls).toHaveLength(1);
  });

  it("classifies a provider-confirmed send failure as terminal", async () => {
    const harness = createMessagingHarness();
    const gateway = new SendblueGateway(harness.config, stubFetch([], () =>
      Response.json({ message_handle: "msg_rejected", status: "ERROR" }),
    ));

    await expect(gateway.send({ to: trustedSender, text: "Never delivered." })).rejects.toMatchObject(
      { name: "MessagingProviderError", kind: "terminal" },
    );
  });

  it("reads delivery status from Sendblue's canonical host", async () => {
    const harness = createMessagingHarness();
    const calls: Request[] = [];
    const gateway = new SendblueGateway(
      {
        ...harness.config,
        sendblue: { ...harness.config.sendblue, baseUrl: "https://api.sendblue.co" },
      },
      stubFetch(calls, () =>
        Response.json(
          { message_handle: "msg_sent_1", status: { status: "DELIVERED" } },
          { headers: { "x-request-id": "req_status_1" } },
        ),
      ),
    );

    const delivery = await gateway.getStatus("msg_sent_1");

    expect(delivery).toEqual({
      messageHandle: "msg_sent_1",
      status: "delivered",
      requestId: "req_status_1",
      error: null,
    });
    const url = new URL(requiredRequest(calls[0]).url);
    expect(url.origin).toBe("https://api.sendblue.co");
    expect(url.pathname).toBe("/api/status");
    expect(url.searchParams.get("handle")).toBe("msg_sent_1");
  });

  it("refuses a status response for a different message handle", async () => {
    const harness = createMessagingHarness();
    const gateway = new SendblueGateway(harness.config, stubFetch([], () =>
      Response.json({ message_handle: "msg_other", status: "DELIVERED" }),
    ));

    await expect(gateway.getStatus("msg_sent_1")).rejects.toMatchObject({
      name: "MessagingProviderError",
      kind: "terminal",
    });
  });
});

describe("Sendblue egress", () => {
  it("prepares one sendblue_send_message intent for every reply", () => {
    const harness = createMessagingHarness();
    const traceId = newTraceId();

    const egressId = harness.egress.prepare({
      traceId,
      recipient: harness.config.userPhoneNumber,
      text: "  Reply body  ",
      purpose: "reply",
      replyToGuid: "msg_inbound_1",
    });

    const intent = writeIntentFor(harness, egressId);
    expect(intent).toMatchObject({ kind: "sendblue_send_message", state: "prepared", egressId });
    expect(intent.request).toEqual({
      to: harness.config.userPhoneNumber,
      text: "Reply body",
      replyTo: "msg_inbound_1",
    });
    expect(egressRow(harness, egressId)).toMatchObject({ state: "prepared", body: "Reply body" });
  });

  it("never replays a send whose acceptance is unknown", async () => {
    const harness = createMessagingHarness();
    const egressId = prepareReply(harness, "Possibly sent.");
    harness.gateway.sendError = new MessagingProviderError({
      message: "Sendblue HTTP 500",
      kind: "ambiguous",
      status: 500,
      requestId: "req_send_1",
    });

    const result = await harness.egress.sendPrepared(egressId);

    expect(result).toMatchObject({ kind: "acceptance_unknown", egressId });
    expect(egressRow(harness, egressId)).toMatchObject({
      state: "acceptance_unknown",
      last_error: "Sendblue HTTP 500",
    });
    expect(writeIntentFor(harness, egressId).state).toBe("ambiguous");
    expect(harness.gateway.sendRequests).toHaveLength(1);

    await expect(harness.egress.sendPrepared(egressId)).rejects.toThrow(/is not prepared/);

    expect(harness.gateway.sendRequests).toHaveLength(1);
  });

  it("records a provider-confirmed send failure without an ambiguous write", async () => {
    const harness = createMessagingHarness();
    const egressId = prepareReply(harness, "Rejected reply.");
    harness.gateway.sendError = new MessagingProviderError({
      message: "Sendblue HTTP 422",
      kind: "terminal",
      status: 422,
    });

    const result = await harness.egress.sendPrepared(egressId);

    expect(result).toMatchObject({ kind: "provider_failed", egressId });
    expect(egressRow(harness, egressId).state).toBe("provider_failed");
    expect(writeIntentFor(harness, egressId).state).toBe("confirmed_failed");
    expect(harness.gateway.sendRequests).toHaveLength(1);
  });

  it("reconciles an accepted send from pending through delivered", async () => {
    const harness = createMessagingHarness();
    const traceId = newTraceId();
    const egressId = prepareReply(harness, "Delivered reply.", traceId);

    const accepted = await harness.egress.sendPrepared(egressId);
    expect(accepted).toEqual({ kind: "accepted", egressId, messageHandle: "msg_handle_1" });
    expect(egressRow(harness, egressId)).toMatchObject({
      state: "accepted",
      outbox_id: "msg_handle_1",
      provider_message_id: null,
    });
    expect(jobRows(harness).map((job) => [job.type, job.subject_id])).toEqual([
      ["egress_reconcile", egressId],
    ]);
    expect(writeIntentFor(harness, egressId).state).toBe("succeeded");

    harness.gateway.statuses = ["pending", "delivered"];
    const pending = await harness.egress.reconcile(egressId);
    expect(pending).toMatchObject({ kind: "pending" });
    expect(egressRow(harness, egressId).poll_count).toBe(1);

    await expect(harness.egress.reconcile(egressId)).resolves.toEqual({ kind: "delivered" });

    expect(egressRow(harness, egressId)).toMatchObject({
      state: "delivered",
      provider_message_id: "msg_handle_1",
    });
    expect(harness.gateway.statusRequests).toEqual(["msg_handle_1", "msg_handle_1"]);
    expect(traceStreamState(harness, traceId)).toBe("terminal");
    expect(
      harness.traces.list(traceId).map((event) => `${event.component}.${event.event}`),
    ).toEqual(
      expect.arrayContaining([
        "egress.prepared",
        "egress.accepted",
        "egress.reconciliation_status_attempted",
        "egress.reconciliation_status_completed",
        "egress.delivered",
      ]),
    );
  });

  it("marks a failed delivery status as a provider failure", async () => {
    const harness = createMessagingHarness();
    const traceId = newTraceId();
    const egressId = prepareReply(harness, "Failed reply.", traceId);
    await harness.egress.sendPrepared(egressId);
    harness.gateway.statuses = ["failed"];

    await expect(harness.egress.reconcile(egressId)).resolves.toEqual({ kind: "failed" });

    expect(egressRow(harness, egressId).state).toBe("provider_failed");
    expect(
      harness.traces
        .list(traceId)
        .filter((event) => event.event === "provider_failed")
        .map((event) => event.outcome),
    ).toEqual(["reconciliation"]);
  });

  it("leaves delivery state untouched when the status read fails", async () => {
    const harness = createMessagingHarness();
    const traceId = newTraceId();
    const egressId = prepareReply(harness, "Unknown delivery.", traceId);
    await harness.egress.sendPrepared(egressId);
    harness.gateway.statusError = new MessagingProviderError({
      message: "Sendblue HTTP 503",
      kind: "transient",
      status: 503,
      requestId: "req_status_failed",
    });

    await expect(harness.egress.reconcile(egressId)).rejects.toMatchObject({
      name: "MessagingProviderError",
      kind: "transient",
      requestId: "req_status_failed",
    });

    expect(egressRow(harness, egressId)).toMatchObject({ state: "accepted", poll_count: 0 });
    expect(
      harness.traces
        .list(traceId)
        .filter((event) => event.event === "reconciliation_status_failed")
        .map((event) => event.providerRequestId),
    ).toEqual(["req_status_failed"]);
  });
});

describe("startup write recovery", () => {
  it("blocks an interrupted egress job and terminalizes its acceptance-unknown trace", () => {
    const harness = createMessagingHarness();
    const traceId = newTraceId();
    const egressId = prepareReply(harness, "Possibly sent.", traceId);
    harness.queue.enqueue({
      chatId: harness.config.userPhoneNumber,
      type: "egress_send",
      subjectId: egressId,
      payload: { egressId },
      traceId,
      availableAtMs: Date.now(),
    });
    const job = requiredJob(harness.queue.claim());
    const writeId = writeIntentFor(harness, egressId).id;
    harness.writes.beginAttempt({
      writeId,
      traceId,
      jobLease: { jobId: job.id, leaseToken: job.leaseToken, nowMs: Date.now() },
    });

    expect(harness.writes.recoverOpenAttempts()).toEqual([writeId]);

    expect(harness.writes.get(writeId)?.state).toBe("ambiguous");
    expect(egressRow(harness, egressId)).toMatchObject({
      state: "acceptance_unknown",
      last_error: "Provider acceptance is unknown after process interruption",
    });
    expect(
      harness.database.handle.db
        .prepare<{ id: string }, { status: string; lease_token: string | null }>(
          "SELECT status, lease_token FROM jobs WHERE id = @id",
        )
        .get({ id: job.id }),
    ).toEqual({ status: "blocked", lease_token: null });
    expect(traceStreamState(harness, traceId)).toBe("terminal");
    expect(
      harness.traces.list(traceId).map((event) => `${event.component}.${event.event}`),
    ).toEqual(
      expect.arrayContaining(["write.ambiguous", "queue.blocked", "egress.acceptance_unknown"]),
    );
    expect(harness.queue.claim(Date.now() + 10_000)).toBeUndefined();
  });
});

describe("failure notifications", () => {
  it("plans one durable, trace-addressable notification per failure", () => {
    const harness = createMessagingHarness();
    const traceId = newTraceId();
    harness.traces.append({
      traceId,
      component: "agent",
      event: "failed",
      outcome: "model_request_limit",
      data: {},
    });
    const failures = new FailureNotificationService({
      db: harness.database.handle.db,
      config: harness.config,
      egress: harness.egress,
      queue: harness.queue,
      traces: harness.traces,
    });

    const first = failures.plan({ traceId, failureCode: "model_request_limit" });
    const duplicate = failures.plan({ traceId, failureCode: "model_request_limit" });

    expect(duplicate).toBe(first);
    expect(egressRow(harness, first)).toMatchObject({
      body: `I couldn't complete that request. Trace: ${traceId}`,
      purpose: "failure",
      state: "prepared",
    });
    expect(countRows(harness, "egress_messages")).toBe(1);
    expect(jobRows(harness).map((job) => [job.type, job.subject_id])).toEqual([
      ["egress_send", first],
    ]);
    expect(
      harness.traces.list(traceId).some((event) => event.component === "failure_notification"),
    ).toBe(true);
  });
});

describe("durable queue leases", () => {
  it("reclaims an expired lease after reopening SQLite and rejects the stale owner", () => {
    const database = createTestDatabase();
    const now = Date.now();
    const redactor = createTraceRedactor([]);
    const traces = new TraceStore(database.handle.db, redactor);
    const queue = new QueueStore({
      db: database.handle.db,
      traces,
      leaseMs: 100,
      maxPending: 8,
    });
    const traceId = newTraceId();
    const jobId = queue.enqueue({
      chatId: trustedSender,
      type: "inbound",
      subjectId: "in_lease",
      payload: { inboundId: "in_lease" },
      traceId,
      availableAtMs: now,
      inboundSequence: 1,
    });
    const firstClaim = queue.claim(now);
    expect(firstClaim?.id).toBe(jobId);
    database.handle.close();

    const reopened = openDatabase(database.config);
    try {
      const reopenedTraces = new TraceStore(reopened.db, redactor);
      const restartedQueue = new QueueStore({
        db: reopened.db,
        traces: reopenedTraces,
        leaseMs: 100,
        maxPending: 8,
      });
      const secondClaim = restartedQueue.claim(now + 101);
      expect(secondClaim).toMatchObject({ id: jobId, attempts: 2 });
      expect(secondClaim?.leaseToken).not.toBe(firstClaim?.leaseToken);
      expect(() => restartedQueue.complete(requiredJob(firstClaim))).toThrow(
        /Lease ownership was lost/,
      );
      restartedQueue.complete(requiredJob(secondClaim));
      const row = reopened.db
        .prepare<{ id: string }, { status: string }>("SELECT status FROM jobs WHERE id = @id")
        .get({ id: jobId });
      expect(row?.status).toBe("succeeded");
    } finally {
      reopened.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("preserves per-chat FIFO while a prior inbound job is running", () => {
    const database = createTestDatabase();
    try {
      const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
      const queue = new QueueStore({
        db: database.handle.db,
        traces,
        leaseMs: 1_000,
        maxPending: 8,
      });
      const now = Date.now();
      queue.enqueue({
        chatId: trustedSender,
        type: "inbound",
        subjectId: "in_1",
        payload: {},
        traceId: newTraceId(),
        availableAtMs: now,
        inboundSequence: 1,
      });
      queue.enqueue({
        chatId: trustedSender,
        type: "inbound",
        subjectId: "in_2",
        payload: {},
        traceId: newTraceId(),
        availableAtMs: now,
        inboundSequence: 2,
      });

      const first = requiredJob(queue.claim(now));
      expect(first.subjectId).toBe("in_1");
      expect(queue.claim(now)).toBeUndefined();
      queue.complete(first);

      expect(queue.claim(now)?.subjectId).toBe("in_2");
    } finally {
      database.cleanup();
    }
  });

  it("removes each idle-poll abort listener after its timer fires", async () => {
    vi.useFakeTimers();
    const database = createTestDatabase();
    try {
      const traces = new TraceStore(database.handle.db, createTraceRedactor([]));
      const queue = new QueueStore({
        db: database.handle.db,
        traces,
        leaseMs: 3_000,
        maxPending: 32,
      });
      const worker = new DurableWorker({
        queue,
        handlers: {
          inbound: async () => undefined,
          egress_send: async () => undefined,
          egress_reconcile: async () => undefined,
        },
        projector: new TraceProjector(database.handle.db, traces, database.config.traceDir),
        pollMs: 10,
        leaseMs: 3_000,
      });
      const controller = new AbortController();
      const running = worker.run(controller.signal);

      await vi.advanceTimersByTimeAsync(55);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      await running;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      database.cleanup();
    }
  });
});

function createMessagingHarness(options: { maxPending?: number } = {}): MessagingHarness {
  const database = createTestDatabase();
  const config = testRuntimeConfig(database);
  const traces = new TraceStore(database.handle.db, createTraceRedactor(config.secretValues));
  const projector = new TraceProjector(database.handle.db, traces, database.config.traceDir);
  const queue = new QueueStore({
    db: database.handle.db,
    traces,
    leaseMs: 1_000,
    maxPending: options.maxPending ?? 32,
  });
  const writes = new WriteStore(database.handle.db, traces);
  const gateway = new FakeSendblueGateway();
  const ingress = new MessageIngressService({
    db: database.handle.db,
    queue,
    traces,
    projector,
    lineNumber: config.sendblue.fromNumber,
    trustedSender: config.userPhoneNumber,
  });
  const egress = new MessageEgressService({
    db: database.handle.db,
    gateway,
    queue,
    traces,
    writes,
    lineNumber: config.sendblue.fromNumber,
  });
  const harness: MessagingHarness = {
    config,
    database,
    queue,
    traces,
    projector,
    writes,
    gateway,
    ingress,
    egress,
    receivers: [],
  };
  harnesses.push(harness);
  return harness;
}

function createReceiver(harness: MessagingHarness): SendblueReceiver {
  const receiver = new SendblueReceiver({
    db: harness.database.handle.db,
    gateway: harness.gateway,
    ingress: harness.ingress,
    traces: harness.traces,
    projector: harness.projector,
  });
  harness.receivers.push(receiver);
  return receiver;
}

function testRuntimeConfig(database: TestDatabase): RuntimeConfig {
  return loadRuntimeConfig({
    NODE_ENV: "test",
    DATA_DIR: database.directory,
    DATABASE_PATH: database.config.databasePath,
    MEMORY_PATH: database.config.memoryPath,
    TRACE_DIR: database.config.traceDir,
    SENDBLUE_API_KEY_ID: "sb_test_key_id",
    SENDBLUE_API_SECRET_KEY: "sb_test_secret_key",
    SENDBLUE_FROM_NUMBER: sendblueLine,
    SENDBLUE_BASE_URL: "https://api.sendblue.test",
    USER_PHONE_NUMBER: trustedSender,
    PUBLIC_BASE_URL: "https://assistant.example",
    GEMINI_API_KEY: "gemini_test_key",
    GOOGLE_CLIENT_ID: "google_test_client",
    GOOGLE_CLIENT_SECRET: "google_test_secret",
    GOOGLE_WORKSPACE_SCOPES: "openid email https://www.googleapis.com/auth/gmail.compose",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
}

function inboundMessage(input: {
  id: string;
  updatedAtMs?: number;
  text?: string | null;
  hasMedia?: boolean;
  senderNumber?: string;
  contactNumber?: string;
  lineNumber?: string;
  recipientNumber?: string;
  isOutbound?: boolean;
  messageType?: InboundMessage["messageType"];
  groupId?: string | null;
  service?: InboundMessage["service"];
  status?: InboundMessage["status"];
}): InboundMessage {
  const updatedAtMs = input.updatedAtMs ?? Date.now();
  return {
    id: input.id,
    senderNumber: input.senderNumber ?? trustedSender,
    contactNumber: input.contactNumber ?? trustedSender,
    lineNumber: input.lineNumber ?? sendblueLine,
    recipientNumber: input.recipientNumber ?? sendblueLine,
    text: input.text === undefined ? "Hello" : input.text,
    hasMedia: input.hasMedia ?? false,
    isOutbound: input.isOutbound ?? false,
    messageType: input.messageType ?? "message",
    groupId: input.groupId ?? null,
    service: input.service ?? "iMessage",
    status: input.status ?? "RECEIVED",
    sentAtMs: updatedAtMs - 500,
    updatedAtMs,
    replyToId: null,
  };
}

function wireMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: "Hello",
    date_sent: new Date(1_700_000_000_000).toISOString(),
    date_updated: new Date(1_700_000_001_000).toISOString(),
    from_number: trustedSender,
    group_id: null,
    is_outbound: false,
    media_url: null,
    message_handle: "msg_wire_1",
    message_type: "message",
    number: trustedSender,
    sendblue_number: sendblueLine,
    service: "iMessage",
    status: "RECEIVED",
    to_number: sendblueLine,
    ...overrides,
  };
}

function stubFetch(calls: Request[], respond: (request: Request) => Response): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    return respond(request);
  };
}

function requiredRequest(request: Request | undefined): Request {
  if (request === undefined) {
    throw new Error("Expected a captured Sendblue request");
  }
  return request;
}

function prepareReply(harness: MessagingHarness, text: string, traceId = newTraceId()): EgressId {
  return harness.egress.prepare({
    traceId,
    recipient: harness.config.userPhoneNumber,
    text,
    purpose: "reply",
  });
}

function cursorRow(harness: MessagingHarness): { updated_at_ms: number; recovered_once: number } {
  const row = harness.database.handle.db
    .prepare<[], { updated_at_ms: number; recovered_once: number }>(`
      SELECT updated_at_ms, recovered_once FROM sendblue_ingress_cursor WHERE id = 1
    `)
    .get();
  if (row === undefined) {
    throw new Error("Expected the Sendblue ingress cursor");
  }
  return row;
}

interface InboundRow {
  provider_message_id: string;
  sequence: number;
  state: string;
  text: string | null;
  is_audio: number;
  attachment_json: string;
}

function inboundRows(harness: MessagingHarness): InboundRow[] {
  return harness.database.handle.db
    .prepare<[], InboundRow>(`
      SELECT provider_message_id, sequence, state, text, is_audio, attachment_json
      FROM inbound_messages ORDER BY sequence
    `)
    .all();
}

interface JobRow {
  type: string;
  subject_id: string;
  status: string;
}

function jobRows(harness: MessagingHarness): JobRow[] {
  return harness.database.handle.db
    .prepare<[], JobRow>("SELECT type, subject_id, status FROM jobs ORDER BY created_at_ms, id")
    .all();
}

interface EgressStateRow {
  state: string;
  body: string;
  purpose: string;
  outbox_id: string | null;
  provider_message_id: string | null;
  poll_count: number;
  last_error: string | null;
}

function egressRow(harness: MessagingHarness, egressId: EgressId): EgressStateRow {
  const row = harness.database.handle.db
    .prepare<{ id: string }, EgressStateRow>(`
      SELECT state, body, purpose, outbox_id, provider_message_id, poll_count, last_error
      FROM egress_messages WHERE id = @id
    `)
    .get({ id: egressId });
  if (row === undefined) {
    throw new Error(`Expected egress ${egressId}`);
  }
  return row;
}

function writeIntentFor(harness: MessagingHarness, egressId: EgressId): WriteIntent {
  const row = harness.database.handle.db
    .prepare<{ id: string }, { write_id: WriteIntentId }>(
      "SELECT id AS write_id FROM write_intents WHERE egress_id = @id",
    )
    .get({ id: egressId });
  if (row === undefined) {
    throw new Error(`Expected a write intent for egress ${egressId}`);
  }
  const intent = harness.writes.get(row.write_id);
  if (intent === undefined) {
    throw new Error(`Expected write intent ${row.write_id}`);
  }
  return intent;
}

function spooledEvents(
  harness: MessagingHarness,
  component: string,
): { event: string; outcome: string | null }[] {
  return harness.database.handle.db
    .prepare<{ component: string }, { event: string; outcome: string | null }>(`
      SELECT event, outcome FROM trace_event_spool
      WHERE component = @component ORDER BY occurred_at_ms, sequence
    `)
    .all({ component });
}

function traceStreamState(harness: MessagingHarness, traceId: TraceId): string | undefined {
  return harness.database.handle.db
    .prepare<{ trace_id: string }, { state: string }>(
      "SELECT state FROM trace_streams WHERE trace_id = @trace_id",
    )
    .get({ trace_id: traceId })?.state;
}

function countRows(
  harness: MessagingHarness,
  table: "webhook_deliveries" | "inbound_messages" | "jobs" | "egress_messages",
): number {
  const row = harness.database.handle.db
    .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
    .get();
  return row?.count ?? 0;
}

function requiredJob(job: ClaimedJob | undefined): ClaimedJob {
  if (job === undefined) {
    throw new Error("Expected a claimed job");
  }
  return job;
}
