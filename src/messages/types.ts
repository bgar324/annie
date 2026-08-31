export const maximumMessageTextCharacters = 18_996;

export interface InboundMessage {
  id: string;
  senderNumber: string;
  contactNumber: string;
  lineNumber: string;
  recipientNumber: string;
  text: string | null;
  hasMedia: boolean;
  isOutbound: boolean;
  messageType: "message" | "group" | "location";
  groupId: string | null;
  service: "iMessage" | "SMS" | "RCS";
  status:
    | "REGISTERED"
    | "PENDING"
    | "SENT"
    | "DELIVERED"
    | "RECEIVED"
    | "QUEUED"
    | "ERROR"
    | "DECLINED"
    | "ACCEPTED"
    | "SUCCESS";
  sentAtMs: number;
  updatedAtMs: number;
  replyToId: string | null;
}

export interface InboundPage {
  messages: readonly InboundMessage[];
  total: number;
  requestId?: string;
}

export interface InboundWakeStream {
  events: AsyncIterable<void>;
  requestId?: string;
}

export interface DeliveryResource {
  messageHandle: string;
  status: "pending" | "sent" | "delivered" | "failed";
  requestId?: string;
  error: string | null;
}

export interface InboundMessageSource {
  listInbound(input: {
    updatedAtGteMs: number;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }): Promise<InboundPage>;
  openInboundWakeStream(signal: AbortSignal): Promise<InboundWakeStream>;
}

export interface MessageSender {
  send(input: { to: string; text: string; replyTo?: string }): Promise<DeliveryResource>;
  getStatus(messageHandle: string): Promise<DeliveryResource>;
}

export interface MessageGateway extends InboundMessageSource, MessageSender {}

export type MessagingFailureKind = "terminal" | "transient" | "ambiguous";

export class MessagingProviderError extends Error {
  readonly kind: MessagingFailureKind;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(input: {
    message: string;
    kind: MessagingFailureKind;
    status?: number;
    requestId?: string;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "MessagingProviderError";
    this.kind = input.kind;
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
  }
}
