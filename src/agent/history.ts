import type Database from "better-sqlite3";
import type { InboundId } from "../core/ids.js";
import type { ModelMessage } from "./model.js";

interface CurrentInboundRow {
  chat_id: string;
  sequence: number;
}

interface HistoryRow {
  user_text: string;
  assistant_text: string;
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
        { chat_id: string; sequence: number; pair_limit: number },
        HistoryRow
      >(`
        SELECT inbound.text AS user_text, runs.final_response AS assistant_text
        FROM inbound_messages AS inbound
        JOIN agent_runs AS runs ON runs.inbound_id = inbound.id
        WHERE inbound.chat_id = @chat_id
          AND inbound.sequence < @sequence
          AND inbound.state = 'done'
          AND runs.phase = 'completed'
          AND inbound.text IS NOT NULL
          AND runs.final_response IS NOT NULL
        ORDER BY inbound.sequence DESC
        LIMIT @pair_limit
      `)
      .all({
        chat_id: current.chat_id,
        sequence: current.sequence,
        pair_limit: Math.floor(this.#messageLimit / 2),
      });

    const selected: HistoryRow[] = [];
    let bytes = 0;
    for (const row of rows) {
      const pairBytes = Buffer.byteLength(row.user_text) + Buffer.byteLength(row.assistant_text);
      if (bytes + pairBytes > this.#maxBytes) {
        break;
      }
      selected.push(row);
      bytes += pairBytes;
    }
    return selected.reverse().flatMap((row) => [
      { role: "user" as const, content: row.user_text },
      { role: "assistant" as const, content: row.assistant_text },
    ]);
  }
}
