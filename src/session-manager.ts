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
      // Try to reconnect if disconnected
      if (!existing.telegram.isConnected()) {
        await existing.telegram.ensureConnected();
      }
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

    const connected = await telegram.connect();

    // Only add to pool if connection succeeded — don't cache broken sessions
    if (connected) {
      this.sessions.set(userId, {
        telegram,
        connectedAt: new Date(),
        lastActivity: new Date(),
      });
    } else {
      console.log(`[sessions] getOrCreateSession: connect failed for ${userId}, not adding to pool`);
    }

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

  /**
   * Disconnect Telegram client (stop update loop) but keep session in pool + SQLite.
   * Used on MCP session close — no TIMEOUT spam, reconnect will reuse same auth key.
   */
  disconnectUser(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) {
      // Save session string before disconnecting (in case it wasn't saved yet)
      const ss = session.telegram.getSessionString();
      if (ss) {
        this.saveSessionString(userId, ss);
      }
      session.telegram.disconnect().catch((err: unknown) => {
        console.error(`[sessions] disconnect failed for ${userId}:`, err);
      });
      // Keep in pool! So adoptSession can logOut, and getOrCreateSession can reuse same auth key
      console.log(`[sessions] Disconnected ${userId} (kept in pool, session string preserved in SQLite)`);
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
        // Reconnect if disconnected, so we can logOut properly
        await session.telegram.ensureConnected();
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

  /** Create a standalone TelegramService (not tracked in the pool) for temporary use like QR login */
  createTempTelegram(): TelegramService {
    return new TelegramService(this.apiId, this.apiHash);
  }

  /**
   * Adopt an already-connected TelegramService into the session pool.
   * Only disconnect() the old instance (stops GramJS) — does NOT logOut().
   * This preserves the auth key so session_string in SQLite stays valid for reconnect.
   * logOut() is only called on explicit revoke (OAuth disconnect).
   */
  async adoptSession(userId: string, telegram: TelegramService): Promise<void> {
    const existing = this.sessions.get(userId);
    if (existing && existing.telegram !== telegram) {
      try {
        // QR login creates a NEW auth key → logOut the old one on Telegram servers
        await existing.telegram.ensureConnected();
        const loggedOut = await existing.telegram.logOut();
        console.log(`[sessions] Old session logOut for ${userId}: ${loggedOut}`);
      } catch (err: unknown) {
        console.error(`[sessions] Old session logOut failed for ${userId}:`, err);
        try {
          await existing.telegram.disconnect();
        } catch {}
      }
    }
    this.sessions.set(userId, {
      telegram,
      connectedAt: new Date(),
      lastActivity: new Date(),
    });
    console.log(`[sessions] Adopted session for ${userId}`);
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  /** Get all saved user IDs from SQLite (for session reuse during OAuth) */
  getSavedUserIds(): string[] {
    const rows = this.db.prepare("SELECT user_id FROM user_sessions").all() as { user_id: string }[];
    return rows.map((r) => r.user_id);
  }

  /**
   * Try to reconnect a SPECIFIC user's session (pool or SQLite).
   * Used when we know the userId from a cookie hint.
   * Returns the TelegramService if successful, null if session is invalid/missing.
   */
  async tryReconnectSession(userId: string): Promise<TelegramService | null> {
    // Fast path: already connected in pool
    const pooled = this.sessions.get(userId);
    if (pooled) {
      try {
        if (pooled.telegram.isConnected() && (await pooled.telegram.ensureConnected())) {
          console.log(`[sessions] tryReconnect: ${userId} — pool hit (already connected)`);
          return pooled.telegram;
        }
      } catch {}
    }

    // Try to reconnect from SQLite session_string with a fresh TelegramService
    const row = this.db.prepare("SELECT session_string FROM user_sessions WHERE user_id = ?").get(userId) as
      | { session_string: string }
      | undefined;

    if (!row?.session_string) {
      console.log(`[sessions] tryReconnect: ${userId} — no session_string in SQLite`);
      return null;
    }

    try {
      const telegram = new TelegramService(this.apiId, this.apiHash);
      telegram.setSessionString(row.session_string);
      await telegram.connect();

      if (telegram.isConnected()) {
        // Success — replace stale pool entry
        if (pooled) {
          pooled.telegram.disconnect().catch(() => {});
        }
        this.sessions.set(userId, {
          telegram,
          connectedAt: new Date(),
          lastActivity: new Date(),
        });
        console.log(`[sessions] tryReconnect: ${userId} — reconnected from SQLite`);
        return telegram;
      }

      // Session invalid — clean up
      console.log(`[sessions] tryReconnect: ${userId} — session_string invalid, removing`);
      this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      this.sessions.delete(userId);
    } catch (err) {
      console.error(`[sessions] tryReconnect: ${userId} — error:`, err);
    }

    return null;
  }

  /** Expose the database for shared use (e.g. OAuth tables) */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
