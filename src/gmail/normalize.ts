import { convert } from "html-to-text";
import { z } from "zod";

const headerSchema = z.object({ name: z.string(), value: z.string() }).loose();
const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z
    .object({
      mimeType: z.string().optional(),
      filename: z.string().optional(),
      headers: z.array(headerSchema).optional(),
      body: z
        .object({
          size: z.number().int().nonnegative().optional(),
          data: z.string().optional(),
          attachmentId: z.string().optional(),
        })
        .loose()
        .optional(),
      parts: z.array(partSchema).optional(),
    })
    .loose(),
);
const messageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1).optional(),
    labelIds: z.array(z.string()).optional(),
    snippet: z.string().optional(),
    internalDate: z.string().optional(),
    payload: partSchema.optional(),
  })
  .loose();
const messageListSchema = z
  .object({
    messages: z.array(z.object({ id: z.string().min(1), threadId: z.string().optional() }).loose()).optional(),
    resultSizeEstimate: z.number().int().nonnegative().optional(),
  })
  .loose();
const threadSchema = z
  .object({
    id: z.string().min(1),
    historyId: z.string().optional(),
    messages: z.array(messageSchema).optional(),
  })
  .loose();
const draftSchema = z
  .object({
    id: z.string().min(1),
    message: z
      .object({ id: z.string().optional(), threadId: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();
const sentMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
  })
  .loose();

interface GmailPart {
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?: {
    size?: number | undefined;
    data?: string | undefined;
    attachmentId?: string | undefined;
  } | undefined;
  parts?: GmailPart[] | undefined;
}

export interface NormalizedGmailMessage {
  id: string;
  threadId: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  snippet: string;
  labels: readonly string[];
}

export interface NormalizedGmailThreadMessage extends NormalizedGmailMessage {
  bodyText: string;
  bodyTruncated: boolean;
  attachments: readonly {
    filename: string;
    mimeType: string;
    size: number | null;
    attachmentId: string | null;
  }[];
}

export function parseGmailMessageList(data: unknown): {
  messages: readonly { id: string; threadId: string | null }[];
  resultSizeEstimate: number | null;
} {
  const parsed = messageListSchema.parse(data);
  return {
    messages: (parsed.messages ?? []).map((message) => ({
      id: message.id,
      threadId: message.threadId ?? null,
    })),
    resultSizeEstimate: parsed.resultSizeEstimate ?? null,
  };
}

export function normalizeGmailMetadata(data: unknown): NormalizedGmailMessage {
  const message = messageSchema.parse(data);
  const headers = headerLookup(message.payload?.headers ?? []);
  return {
    id: message.id,
    threadId: message.threadId ?? null,
    from: headers.get("from") ?? null,
    to: headers.get("to") ?? null,
    subject: headers.get("subject") ?? null,
    date: headers.get("date") ?? null,
    messageId: headers.get("message-id") ?? null,
    snippet: truncateUtf8(message.snippet ?? "", 512).value,
    labels: [...(message.labelIds ?? [])].sort(),
  };
}

export function normalizeGmailThread(data: unknown): {
  id: string;
  historyId: string | null;
  messages: readonly NormalizedGmailThreadMessage[];
  messagesTruncated: boolean;
} {
  const thread = threadSchema.parse(data);
  const providerMessages = thread.messages ?? [];
  const messages: NormalizedGmailThreadMessage[] = [];
  let remainingBodyBytes = 131_072;
  for (const message of providerMessages.slice(0, 50)) {
    const normalized = normalizeFullMessage(message, Math.min(remainingBodyBytes, 32_768));
    messages.push(normalized);
    remainingBodyBytes = Math.max(0, remainingBodyBytes - Buffer.byteLength(normalized.bodyText));
  }
  return {
    id: thread.id,
    historyId: thread.historyId ?? null,
    messages,
    messagesTruncated: providerMessages.length > messages.length,
  };
}

export function parseCreatedDraft(data: unknown): {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
} {
  const draft = draftSchema.parse(data);
  return {
    draftId: draft.id,
    messageId: draft.message?.id ?? null,
    threadId: draft.message?.threadId ?? null,
  };
}

export function parseSentMessage(data: unknown): {
  messageId: string;
  threadId: string | null;
  labels: readonly string[];
} {
  const message = sentMessageSchema.parse(data);
  return {
    messageId: message.id,
    threadId: message.threadId ?? null,
    labels: [...(message.labelIds ?? [])].sort(),
  };
}

function normalizeFullMessage(
  message: z.infer<typeof messageSchema>,
  maximumBodyBytes: number,
): NormalizedGmailThreadMessage {
  const metadata = normalizeGmailMetadata(message);
  const collected = collectParts(message.payload, maximumBodyBytes);
  const preferred = collected.plain.length > 0
    ? collected.plain.join("\n")
    : collected.html.length > 0
      ? convert(collected.html.join("\n"), {
          wordwrap: false,
          selectors: [
            { selector: "a", options: { ignoreHref: true } },
            { selector: "img", format: "skip" },
          ],
        })
      : "";
  const body = truncateUtf8(preferred, maximumBodyBytes);
  return {
    ...metadata,
    bodyText: body.value,
    bodyTruncated: body.truncated || collected.truncated,
    attachments: collected.attachments,
  };
}

function collectParts(part: GmailPart | undefined, maximumBytes: number): {
  plain: string[];
  html: string[];
  attachments: NormalizedGmailThreadMessage["attachments"];
  truncated: boolean;
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: NormalizedGmailThreadMessage["attachments"][number][] = [];
  const stack: { part: GmailPart; depth: number }[] = part === undefined ? [] : [{ part, depth: 0 }];
  let decodedBytes = 0;
  let visited = 0;
  let truncated = false;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) {
      break;
    }
    visited += 1;
    if (visited > 100 || next.depth > 8) {
      truncated = true;
      continue;
    }
    for (const child of [...(next.part.parts ?? [])].reverse()) {
      stack.push({ part: child, depth: next.depth + 1 });
    }
    if ((next.part.filename ?? "").length > 0 || next.part.body?.attachmentId !== undefined) {
      attachments.push({
        filename: next.part.filename ?? "attachment",
        mimeType: next.part.mimeType ?? "application/octet-stream",
        size: next.part.body?.size ?? null,
        attachmentId: next.part.body?.attachmentId ?? null,
      });
      continue;
    }
    const encoded = next.part.body?.data;
    if (encoded === undefined || decodedBytes >= maximumBytes) {
      continue;
    }
    const decoded = decodeBase64Url(encoded, maximumBytes - decodedBytes);
    decodedBytes += Buffer.byteLength(decoded.value);
    truncated ||= decoded.truncated;
    const mimeType = (next.part.mimeType ?? "").toLowerCase();
    if (mimeType.startsWith("text/plain")) {
      plain.push(decoded.value);
    } else if (mimeType.startsWith("text/html")) {
      html.push(decoded.value);
    }
  }
  return { plain, html, attachments, truncated };
}

function decodeBase64Url(encoded: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(encoded)) {
    return { value: "", truncated: true };
  }
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4 + 4;
  const clipped = encoded.length > maximumEncodedLength;
  const buffer = Buffer.from(clipped ? encoded.slice(0, maximumEncodedLength) : encoded, "base64url");
  const decoded = truncateUtf8(buffer.toString("utf8"), maximumBytes);
  return { value: decoded.value, truncated: clipped || decoded.truncated };
}

function headerLookup(headers: readonly { name: string; value: string }[]): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (!lookup.has(name)) {
      lookup.set(name, header.value);
    }
  }
  return lookup;
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) {
    return { value, truncated: false };
  }
  let end = maximumBytes;
  for (;;) {
    const byte = encoded[end];
    if (end === 0 || byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    end -= 1;
  }
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}
