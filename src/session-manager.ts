import { TelegramService } from "@overpod/mcp-telegram/service";
import Database from "better-sqlite3";

interface UserSession {
  telegram: TelegramService;
  connectedAt: Date;
  lastActivity: Date;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private db: Database.Database;

  private readonly apiId = Number(process.env.TELEGRAM_API_ID);
  private readonly apiHash = process.env.TELEGRAM_API_HASH ?? "";

  constructor(dbPath = "data/sessions.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        user_id TEXT PRIMARY KEY,
        session_string TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  async getOrCreateSession(userId: string): Promise<TelegramService> {
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.lastActivity = new Date();
      return existing.telegram;
    }

    const telegram = new TelegramService(this.apiId, this.apiHash);

    // Try to load saved session from SQLite
    const row = this.db.prepare("SELECT session_string FROM user_sessions WHERE user_id = ?").get(userId) as
      | { session_string: string }
      | undefined;

    if (row?.session_string) {
      telegram.setSessionString(row.session_string);
    }

    await telegram.connect();

    this.sessions.set(userId, {
      telegram,
      connectedAt: new Date(),
      lastActivity: new Date(),
    });

    return telegram;
  }

  /** Save a user's session string to SQLite for persistence across restarts */
  saveSessionString(userId: string, sessionString: string): void {
    this.db
      .prepare(
        `INSERT INTO user_sessions (user_id, session_string, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET session_string = excluded.session_string, updated_at = datetime('now')`,
      )
      .run(userId, sessionString);
  }

  getSession(userId: string): TelegramService | undefined {
    const session = this.sessions.get(userId);
    if (session) {
      session.lastActivity = new Date();
    }
    return session?.telegram;
  }

  async disconnectUser(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (session) {
      await session.telegram.disconnect();
      this.sessions.delete(userId);
    }
  }

  /**
   * Full session destruction: logout from Telegram, remove from memory and SQLite.
   * Used when user disconnects the connector (OAuth revoke).
   */
  async destroyUserSession(userId: string): Promise<{ loggedOut: boolean }> {
    let loggedOut = false;
    const session = this.sessions.get(userId);

    if (session) {
      try {
        loggedOut = await session.telegram.logOut();
        console.log(`[sessions] Telegram logOut for ${userId}: ${loggedOut}`);
      } catch (error) {
        console.error(`[sessions] Telegram logOut failed for ${userId}:`, error);
        try {
          await session.telegram.disconnect();
        } catch {}
      }
      this.sessions.delete(userId);
    }

    // Remove session string from SQLite
    this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
    console.log(`[sessions] Destroyed session for ${userId} (loggedOut=${loggedOut})`);

    return { loggedOut };
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  /** Expose the database for shared use (e.g. OAuth tables) */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
