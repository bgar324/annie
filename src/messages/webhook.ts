import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { wakeHintDigest, type SendblueReceiver } from "./receiver.js";

const webhookPath = "/webhooks/sendblue";
const signingSecretHeader = "sb-signing-secret";
const maximumBodyBytes = 64 * 1_024;

/**
 * Only the fields that decide whether this callback is ours. Everything else Sendblue
 * sends — message text, media URLs — is dropped here: the webhook is a reason to sweep,
 * and the authoritative list is the only thing allowed to produce a message.
 */
const receiveEventSchema = z.object({
  from_number: z.string().min(1).max(64),
  number: z.string().min(1).max(64),
  to_number: z.string().min(1).max(64),
  sendblue_number: z.string().min(1).max(64),
  // Receive callbacks carry the inbound lifecycle status; treat a missing flag as
  // inbound and let `status` do the real work, but never accept an explicit outbound.
  is_outbound: z.boolean().optional(),
  message_type: z.string().max(64),
  group_id: z.string().max(512).nullish(),
  service: z.string().max(32),
  status: z.string().max(32),
  message_handle: z.string().min(1).max(512),
});

/**
 * Registers the Sendblue receive webhook. The route exists whether or not a secret is
 * configured — an unconfigured deployment answers 503 rather than accepting unverified
 * callers — and it never writes message data: an authenticated callback for the exact
 * trusted sender on the exact line commits a durable wake hint and nothing else.
 */
export function registerSendblueWebhook(input: {
  app: FastifyInstance;
  receiver: SendblueReceiver;
  secret: string | undefined;
  lineNumber: string;
  trustedSender: string;
}): void {
  input.app.post(webhookPath, { bodyLimit: maximumBodyBytes }, async (request, reply) => {
    const secret = input.secret;
    if (secret === undefined) {
      request.log.warn({ webhook: "sendblue" }, "sendblue webhook secret is not configured");
      return reply.code(503).send({ ok: false });
    }
    const presented = request.headers[signingSecretHeader];
    if (typeof presented !== "string" || !equalSecret(presented, secret)) {
      request.log.warn(
        { webhook: "sendblue", authenticated: false },
        "sendblue webhook rejected",
      );
      return reply.code(401).send({ ok: false });
    }

    const event = receiveEventSchema.safeParse(request.body);
    if (!event.success) {
      // Authenticated but unreadable. A real message may still be waiting on the list,
      // so take the wake without the claim instead of risking a dropped message.
      input.receiver.requestWake();
      request.log.warn(
        { webhook: "sendblue", authenticated: true, parsed: false },
        "sendblue webhook payload not recognized",
      );
      return reply.code(202).send({ ok: true });
    }

    const body = event.data;
    const senderMatched =
      body.from_number === input.trustedSender && body.number === input.trustedSender;
    const lineMatched =
      body.sendblue_number === input.lineNumber && body.to_number === input.lineNumber;
    const inboundMessage =
      body.is_outbound !== true &&
      body.message_type === "message" &&
      // The live one-to-one payload carries an empty group id rather than a null one.
      (body.group_id ?? "") === "" &&
      body.service === "iMessage" &&
      body.status === "RECEIVED";
    if (!senderMatched || !lineMatched || !inboundMessage) {
      request.log.info(
        { webhook: "sendblue", authenticated: true, senderMatched, lineMatched, inboundMessage },
        "sendblue webhook ignored",
      );
      return reply.code(204).send();
    }

    // Durable before the acknowledgement: Sendblue and the wake broker are entitled to
    // stop retrying the moment they see 2xx, so the reason to sweep has to already have
    // outlived this process before the reply leaves.
    input.receiver.requestWake(body.message_handle);
    request.log.info(
      {
        webhook: "sendblue",
        authenticated: true,
        senderMatched: true,
        lineMatched: true,
        inboundMessage: true,
        hintDigest: wakeHintDigest(body.message_handle),
      },
      "sendblue wake hint committed",
    );
    return reply.send({ ok: true });
  });
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
