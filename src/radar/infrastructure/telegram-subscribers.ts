import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { Db } from "../../persistence/infrastructure/db";
import {
  TelegramNotifier,
  TextNotifier,
} from "../../delivery/infrastructure/telegram-notifier";

/** Fork-only tables, initialized idempotently in its independent database. */
export class TelegramSubscribers {
  constructor(private readonly db: Db) {
    db.run(
      sql`CREATE TABLE IF NOT EXISTS radar_subscribers (chat_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1)`,
    );
    db.run(
      sql`CREATE TABLE IF NOT EXISTS radar_bot_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), offset INTEGER NOT NULL)`,
    );
    db.run(
      sql`CREATE TABLE IF NOT EXISTS radar_chat_deliveries (chat_id TEXT NOT NULL, digest_hash TEXT NOT NULL, PRIMARY KEY(chat_id, digest_hash))`,
    );
  }
  subscribe(chatId: string): void {
    this.db.run(
      sql`INSERT INTO radar_subscribers(chat_id, active) VALUES (${chatId}, 1) ON CONFLICT(chat_id) DO UPDATE SET active=1`,
    );
  }
  unsubscribe(chatId: string): void {
    this.db.run(
      sql`UPDATE radar_subscribers SET active=0 WHERE chat_id=${chatId}`,
    );
  }
  active(): string[] {
    return this.db
      .all<{ chat_id: string }>(
        sql`SELECT chat_id FROM radar_subscribers WHERE active=1 ORDER BY chat_id`,
      )
      .map((row) => row.chat_id);
  }
  offset(): number {
    return (
      this.db.get<{ offset: number }>(
        sql`SELECT offset FROM radar_bot_cursor WHERE id=1`,
      )?.offset ?? 0
    );
  }
  advance(offset: number): void {
    this.db.run(
      sql`INSERT INTO radar_bot_cursor(id, offset) VALUES (1, ${offset}) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset`,
    );
  }
  delivered(chatId: string, hash: string): boolean {
    return !!this.db.get(
      sql`SELECT 1 FROM radar_chat_deliveries WHERE chat_id=${chatId} AND digest_hash=${hash}`,
    );
  }
  markDelivered(chatId: string, hash: string): void {
    this.db.run(
      sql`INSERT OR IGNORE INTO radar_chat_deliveries(chat_id, digest_hash) VALUES (${chatId}, ${hash})`,
    );
  }
}

export class SubscriberNotifier implements TextNotifier {
  constructor(
    private readonly subscribers: TelegramSubscribers,
    private readonly botToken: string,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async sendText(text: string) {
    const chats = this.subscribers.active();
    if (!chats.length)
      return {
        ok: false as const,
        error: { message: "Nenhum assinante ativo no Telegram" },
      };
    const hash = createHash("sha256").update(text).digest("hex");
    let failure: string | undefined;
    for (const chatId of chats) {
      if (this.subscribers.delivered(chatId, hash)) continue;
      const result = await new TelegramNotifier(
        { botToken: this.botToken, chatId },
        this.transport,
      ).sendText(text);
      if (result.ok) this.subscribers.markDelivered(chatId, hash);
      else if (result.error.message === "Telegram request failed: 403")
        this.subscribers.unsubscribe(chatId);
      else failure = result.error.message;
    }
    return failure
      ? { ok: false as const, error: { message: failure } }
      : { ok: true as const };
  }
}

interface BotUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string } };
}

export async function pollSubscribers(
  subscribers: TelegramSubscribers,
  botToken: string,
  transport: typeof fetch = fetch,
): Promise<void> {
  const response = await transport(
    `https://api.telegram.org/bot${botToken}/getUpdates`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset: subscribers.offset(),
        timeout: 0,
        allowed_updates: ["message"],
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = (await response.json()) as { ok: boolean; result?: BotUpdate[] };
  if (!response.ok || !body.ok || !Array.isArray(body.result))
    throw new Error("Falha ao consultar assinantes do Telegram");
  for (const update of body.result) {
    const message = update.message;
    const command = message?.text?.trim().split(/\s/)[0]?.split("@")[0];
    if (
      message?.chat.type === "private" &&
      (command === "/start" || command === "/stop")
    ) {
      const chatId = String(message.chat.id);
      if (command === "/start") subscribers.subscribe(chatId);
      else subscribers.unsubscribe(chatId);
      const result = await new TelegramNotifier(
        { botToken, chatId },
        transport,
      ).sendText(
        command === "/start"
          ? "Inscrição confirmada! Você receberá vagas generalistas sem faculdade, presenciais em Joinville ou remotas no Brasil. Use /stop para parar de receber."
          : "Inscrição cancelada. Use /start para voltar a receber vagas.",
      );
      if (!result.ok && result.error.message !== "Telegram request failed: 403")
        throw new Error("Falha ao confirmar inscrição no Telegram");
      if (!result.ok) subscribers.unsubscribe(chatId);
    }
    subscribers.advance(update.update_id + 1);
  }
}
