import type Database from "better-sqlite3";
import type { EgressId, InboundId } from "../core/ids.js";
import type { ModelMessage } from "./model.js";
import { assistantHistoryText } from "./prompt.js";

interface CurrentInboundRow {
  chat_id: string;
  sequence: number;
}

interface HistoryRow {
  user_text: string;
  final_response: string | null;
  delivered_reply_body: string | null;
  delivered_link: number;
}

interface PrecedingReplyRow {
  egress_id: EgressId;
  body: string;
}

export class ConversationHistoryStore {
  readonly #db: Database.Database;
  readonly #messageLimit: number;
  readonly #maxBytes: number;

  constructor(db: Database.Database, messageLimit: number, maxBytes = 32_768) {
    this.#db = db;
    this.#messageLimit = messageLimit;
    this.#maxBytes = maxBytes;
  }

  /**
   * Every earlier accepted user request stays in history: the user said it regardless of
   * what happened afterwards. An assistant turn appears only when that run's own message
   * reached the user, and it carries what was actually delivered. A connection request
   * instead contributes its stored URL-free message, never the signed one-time link that
   * was sent. A reply that failed, was blocked, or whose delivery is unknown contributes
   * no assistant turn and no claim about why.
   */
  loadBefore(inboundId: InboundId): readonly ModelMessage[] {
    const current = this.#db
      .prepare<{ id: string }, CurrentInboundRow>(`
        SELECT chat_id, sequence FROM inbound_messages WHERE id = @id
      `)
      .get({ id: inboundId });
    if (current === undefined) {
      throw new Error(`Unknown inbound message: ${inboundId}`);
    }
    const rows = this.#db
      .prepare<
        { chat_id: string; sequence: number; row_limit: number },
        HistoryRow
      >(`
        SELECT
          inbound.text AS user_text,
          runs.final_response AS final_response,
          (
            SELECT reply.body
            FROM egress_messages AS reply
            WHERE reply.run_id = runs.id
              AND reply.purpose = 'reply'
              AND reply.state = 'delivered'
            ORDER BY reply.created_at_ms, reply.id
            LIMIT 1
          ) AS delivered_reply_body,
          EXISTS (
            SELECT 1
            FROM egress_messages AS link
            WHERE link.run_id = runs.id
              AND link.purpose IN ('recovery', 'oauth_result')
              AND link.state = 'delivered'
          ) AS delivered_link
        FROM inbound_messages AS inbound
        LEFT JOIN agent_runs AS runs ON runs.inbound_id = inbound.id
        WHERE inbound.chat_id = @chat_id
          AND inbound.sequence < @sequence
          AND inbound.state <> 'rejected'
          AND inbound.text IS NOT NULL
        ORDER BY inbound.sequence DESC
        LIMIT @row_limit
      `)
      .all({
        chat_id: current.chat_id,
        sequence: current.sequence,
        row_limit: this.#messageLimit,
      });

    const turns: ModelMessage[][] = [];
    let bytes = 0;
    let messages = 0;
    for (const row of rows) {
      const turn: ModelMessage[] = [{ role: "user", content: row.user_text }];
      if (row.final_response !== null) {
        const deliveredText =
          row.delivered_reply_body ??
          (row.delivered_link === 1 ? row.final_response : null);
        const assistantText =
          deliveredText === null ? null : assistantHistoryText(deliveredText);
        if (assistantText !== null) {
          turn.push({ role: "assistant", content: assistantText });
        }
      }
      const turnBytes = turn.reduce(
        (total, message) => total + Buffer.byteLength(message.content),
        0,
      );
      if (bytes + turnBytes > this.#maxBytes || messages + turn.length > this.#messageLimit) {
        break;
      }
      turns.push(turn);
      bytes += turnBytes;
      messages += turn.length;
    }
    return turns.reverse().flat();
  }

  /**
   * The one reply the current message can be answering: the delivered model-authored reply
   * to the immediately preceding accepted message in this chat, prepared before the current
   * message arrived, within the freshness window, with nothing else sent to the user in
   * between. Failure notices, connection links, undelivered or delivery-unknown replies,
   * and older replies contribute nothing, so an answer can complete only a question Annie
   * is known to have just asked.
   */
  precedingDeliveredReply(
    inboundId: InboundId,
    maxAgeMs: number,
  ): { egressId: EgressId; body: string } | undefined {
    const row = this.#db
      .prepare<{ id: string; max_age_ms: number }, PrecedingReplyRow>(`
        SELECT reply.id AS egress_id, reply.body AS body
        FROM inbound_messages AS current
        JOIN inbound_messages AS previous
          ON previous.chat_id = current.chat_id
         AND previous.sequence = (
           SELECT MAX(sequence) FROM inbound_messages
           WHERE chat_id = current.chat_id
             AND sequence < current.sequence
             AND state <> 'rejected'
         )
        JOIN agent_runs AS runs ON runs.inbound_id = previous.id
        JOIN egress_messages AS reply
          ON reply.run_id = runs.id
         AND reply.purpose = 'reply'
         AND reply.state = 'delivered'
        WHERE current.id = @id
          AND reply.created_at_ms < current.created_at_ms
          AND reply.created_at_ms >= current.created_at_ms - @max_age_ms
          AND NOT EXISTS (
            SELECT 1 FROM egress_messages AS later
            WHERE later.recipient_handle = reply.recipient_handle
              AND later.id <> reply.id
              AND later.created_at_ms > reply.created_at_ms
              AND later.created_at_ms < current.created_at_ms
          )
        ORDER BY reply.created_at_ms DESC
        LIMIT 1
      `)
      .get({ id: inboundId, max_age_ms: maxAgeMs });
    return row === undefined ? undefined : { egressId: row.egress_id, body: row.body };
  }
}
