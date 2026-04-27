import type Database from "better-sqlite3";

/**
 * Subscribers of the in-product Telegram broadcast bot (Phase 0.1).
 *
 * One row per Telegram user who interacted with the bot. `unsubscribed_at` is
 * non-null when the user sent /stop or blocked the bot — we keep the row so
 * subsequent /start re-subscribes them without losing original join time.
 */
export class Subscribers {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_subscribers (
        telegram_id INTEGER PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'start',
        subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
        unsubscribed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bot_subscribers_active
        ON bot_subscribers(unsubscribed_at) WHERE unsubscribed_at IS NULL;
    `);
  }

  subscribe(telegramId: number, source = "start"): void {
    this.db
      .prepare(
        `INSERT INTO bot_subscribers (telegram_id, source)
         VALUES (?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET unsubscribed_at = NULL`,
      )
      .run(telegramId, source);
  }

  /** Mark as unsubscribed. Idempotent. */
  unsubscribe(telegramId: number): void {
    this.db
      .prepare(
        `UPDATE bot_subscribers SET unsubscribed_at = datetime('now')
         WHERE telegram_id = ? AND unsubscribed_at IS NULL`,
      )
      .run(telegramId);
  }

  /** Mark many users as unsubscribed in a single transaction (one fsync). */
  bulkUnsubscribe(telegramIds: number[]): void {
    if (telegramIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE bot_subscribers SET unsubscribed_at = datetime('now')
       WHERE telegram_id = ? AND unsubscribed_at IS NULL`,
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id);
    });
    tx(telegramIds);
  }

  listActive(): number[] {
    const rows = this.db
      .prepare("SELECT telegram_id FROM bot_subscribers WHERE unsubscribed_at IS NULL ORDER BY telegram_id")
      .all() as { telegram_id: number }[];
    return rows.map((r) => r.telegram_id);
  }
}
