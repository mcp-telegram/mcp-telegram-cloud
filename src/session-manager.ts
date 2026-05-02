import { TelegramService } from "@overpod/mcp-telegram/service";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { logUser } from "./logger.js";

interface UserSession {
  telegram: TelegramService;
  connectedAt: Date;
  lastActivity: Date;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  /**
   * Per-userId async mutex. Every public method that mutates `sessions` for a userId
   * (create / replace / delete) — and every read that depends on the result of such a
   * mutation — is queued through `withLock(userId, ...)` so concurrent calls for the SAME
   * userId run strictly in series. Different userIds remain fully parallel.
   *
   * Closes three race windows:
   *   1. Cold-start: 3 MCP clients (Claude.ai + ChatGPT + Cursor) issuing the first tool call
   *      simultaneously after a container restart would each see `sessions.get(userId) === undefined`
   *      and each spin up a fresh `TelegramService` against the same `session_string` →
   *      `AUTH_KEY_DUPLICATED` from Telegram, all clients lose auth.
   *   2. Destroy/adopt vs pending create: a `getOrCreateSession` connect that resolves AFTER a
   *      concurrent `destroyUserSession` would leave a live, unreferenced TelegramService.
   *   3. Adopt vs concurrent tool dispatch: `getSession` is called on every MCP tool dispatch
   *      and must NOT hand out a TelegramService that is mid-logOut. `adoptSession` therefore
   *      installs the new entry FIRST and tears down the old instance fire-and-forget after.
   *
   * `disconnectUser` is also wrapped, but its actual `disconnect()` call is fire-and-forget
   * inside the lock so a stuck network teardown does not block the queue head for that userId.
   *
   * Stored value is the tail Promise of the per-user queue; resolved Promises are evicted in
   * `withLock`'s finally block so the Map does not grow unboundedly.
   */
  private locks = new Map<string, Promise<void>>();
  private db: Database.Database;

  private readonly apiId = config.telegramApiId;
  private readonly apiHash = config.telegramApiHash;

  constructor(
    dbPath = config.databasePath,
    /**
     * Optional factory for `TelegramService` instances. Defaults to the real constructor.
     * Tests inject a stub here to observe mutex behaviour without touching the network or
     * GramJS internals — this is the ONLY supported way to substitute the Telegram client.
     */
    private readonly telegramFactory: (apiId: number, apiHash: string) => TelegramService = (apiId, apiHash) =>
      new TelegramService(apiId, apiHash),
  ) {
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

  /**
   * Run `fn` after any in-flight operation for the same userId completes, then evict the
   * lock entry if no further work is queued behind us.
   *
   * The slot stored in `this.locks` is a never-rejecting view of the chain head — that is
   * what isolates a thrown `fn` from blocking the next caller, NOT the `prev.then` arity.
   * Concretely: caller B reads slotA from the Map, slotA always fulfils (it's `runA.then(noop, noop)`),
   * so `slotA.then(fnB)` always invokes fnB. No `.then(fn, fn)` rejection-arm trickery needed.
   *
   * The await-then-finally cleanup is microtask-tight: `this.locks.set(userId, slot)` is
   * synchronous and reference-equal at finally time, so eviction never racially-deletes a
   * successor's freshly-installed slot.
   */
  private async withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn);
    // Non-rejecting view of the chain head: future callers chain off this without inheriting
    // a rejection, and we keep reference equality for the cleanup check below.
    const slot: Promise<void> = run.then(
      () => {},
      () => {},
    );
    this.locks.set(userId, slot);
    try {
      return await run;
    } finally {
      // Only evict if nobody chained behind us in the meantime
      if (this.locks.get(userId) === slot) {
        this.locks.delete(userId);
      }
    }
  }

  async getOrCreateSession(userId: string): Promise<TelegramService> {
    return this.withLock(userId, () => this.getOrCreateSessionImpl(userId));
  }

  private async getOrCreateSessionImpl(userId: string): Promise<TelegramService> {
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.lastActivity = new Date();
      // Try to reconnect if disconnected
      if (!existing.telegram.isConnected()) {
        await existing.telegram.ensureConnected();
      }
      return existing.telegram;
    }

    const telegram = this.telegramFactory(this.apiId, this.apiHash);

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
      console.log(`[sessions] getOrCreateSession: connect failed for ${logUser(userId)}, not adding to pool`);
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
   *
   * Intentionally NOT serialized through `withLock`: synchronous fire-and-forget that does
   * not mutate the pool Map (the entry stays so subsequent getOrCreateSession reuses the
   * same auth key). Wrapping it would require making the public method async and awaiting
   * `disconnect()`, which on a stuck connection would block all other ops on this userId.
   */
  /**
   * Disconnect Telegram client (stop update loop) but keep session in pool + SQLite.
   * Used on MCP session close — no TIMEOUT spam, reconnect will reuse same auth key.
   *
   * Public API stays sync (fire-and-forget) — callers in `mcp-handler.ts` do not await it.
   * The lock-protected portion only saves the session_string; the actual `disconnect()` is
   * launched inside the lock but not awaited, so a stuck network teardown does NOT block
   * subsequent ops on this userId. Compared to wrapping the whole thing, this gives us
   * Map-read serialisation against `destroyUserSession` / `adoptSession` without trading
   * latency for safety.
   */
  disconnectUser(userId: string): void {
    // Fire-and-forget the lock acquisition itself. We never await the result of
    // disconnectUser at any callsite, and any internal logging is on the inner promise.
    this.withLock(userId, async () => {
      const session = this.sessions.get(userId);
      if (!session) return;
      // Save session string before disconnecting (in case it wasn't saved yet)
      const ss = session.telegram.getSessionString();
      if (ss) {
        this.saveSessionString(userId, ss);
      }
      // NOT awaited: a stuck network teardown should not pin the userId queue.
      session.telegram.disconnect().catch((err: unknown) => {
        console.error(`[sessions] disconnect failed for ${logUser(userId)}:`, err);
      });
      // Keep in pool! So adoptSession can logOut, and getOrCreateSession can reuse same auth key
      console.log(`[sessions] Disconnected ${logUser(userId)} (kept in pool, session string preserved in SQLite)`);
    }).catch((err: unknown) => {
      console.error(`[sessions] disconnectUser lock-handler failed for ${logUser(userId)}:`, err);
    });
  }

  /**
   * Full session destruction: logout from Telegram, remove from memory and SQLite.
   * Used when user disconnects the connector (OAuth revoke).
   */
  async destroyUserSession(userId: string): Promise<{ loggedOut: boolean }> {
    return this.withLock(userId, () => this.destroyUserSessionImpl(userId));
  }

  private async destroyUserSessionImpl(userId: string): Promise<{ loggedOut: boolean }> {
    let loggedOut = false;
    const session = this.sessions.get(userId);

    if (session) {
      try {
        // Reconnect if disconnected, so we can logOut properly
        await session.telegram.ensureConnected();
        loggedOut = await session.telegram.logOut();
        console.log(`[sessions] Telegram logOut for ${logUser(userId)}: ${loggedOut}`);
      } catch (error) {
        console.error(`[sessions] Telegram logOut failed for ${logUser(userId)}:`, error);
        try {
          await session.telegram.disconnect();
        } catch {}
      }
      this.sessions.delete(userId);
    }

    // Remove session string from SQLite
    this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
    console.log(`[sessions] Destroyed session for ${logUser(userId)} (loggedOut=${loggedOut})`);

    return { loggedOut };
  }

  /** Create a standalone TelegramService (not tracked in the pool) for temporary use like QR login */
  createTempTelegram(): TelegramService {
    return this.telegramFactory(this.apiId, this.apiHash);
  }

  /**
   * Adopt an already-connected TelegramService into the session pool.
   * Only disconnect() the old instance (stops GramJS) — does NOT logOut().
   * This preserves the auth key so session_string in SQLite stays valid for reconnect.
   * logOut() is only called on explicit revoke (OAuth disconnect).
   */
  async adoptSession(userId: string, telegram: TelegramService): Promise<void> {
    return this.withLock(userId, () => this.adoptSessionImpl(userId, telegram));
  }

  private async adoptSessionImpl(userId: string, telegram: TelegramService): Promise<void> {
    const existing = this.sessions.get(userId);
    // Install the new entry FIRST so concurrent `getSession(userId)` (called on every MCP
    // tool dispatch via mcp-handler.ts:140) immediately sees the live, connected instance —
    // never a TelegramService that is mid-logOut. The teardown of the old auth key happens
    // fire-and-forget after the swap.
    this.sessions.set(userId, {
      telegram,
      connectedAt: new Date(),
      lastActivity: new Date(),
    });
    if (existing && existing.telegram !== telegram) {
      // QR login created a NEW auth key on Telegram's side → the old one must be revoked.
      // Fire-and-forget so callers (notably routes/oauth.tsx after a fresh QR flow) get a
      // fast response. logOut failures fall back to a best-effort disconnect.
      void (async () => {
        try {
          await existing.telegram.ensureConnected();
          const loggedOut = await existing.telegram.logOut();
          console.log(`[sessions] Old session logOut for ${logUser(userId)}: ${loggedOut}`);
        } catch (err: unknown) {
          console.error(`[sessions] Old session logOut failed for ${logUser(userId)}:`, err);
          try {
            await existing.telegram.disconnect();
          } catch {}
        }
      })();
    }
    console.log(`[sessions] Adopted session for ${logUser(userId)}`);
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
    return this.withLock(userId, () => this.tryReconnectSessionImpl(userId));
  }

  private async tryReconnectSessionImpl(userId: string): Promise<TelegramService | null> {
    // Fast path: already connected in pool
    const pooled = this.sessions.get(userId);
    if (pooled) {
      try {
        if (pooled.telegram.isConnected() && (await pooled.telegram.ensureConnected())) {
          console.log(`[sessions] tryReconnect: ${logUser(userId)} — pool hit (already connected)`);
          return pooled.telegram;
        }
      } catch {}
    }

    // Try to reconnect from SQLite session_string with a fresh TelegramService
    const row = this.db.prepare("SELECT session_string FROM user_sessions WHERE user_id = ?").get(userId) as
      | { session_string: string }
      | undefined;

    if (!row?.session_string) {
      console.log(`[sessions] tryReconnect: ${logUser(userId)} — no session_string in SQLite`);
      return null;
    }

    try {
      const telegram = this.telegramFactory(this.apiId, this.apiHash);
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
        console.log(`[sessions] tryReconnect: ${logUser(userId)} — reconnected from SQLite`);
        return telegram;
      }

      // Session invalid — clean up
      console.log(`[sessions] tryReconnect: ${logUser(userId)} — session_string invalid, removing`);
      this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      this.sessions.delete(userId);
    } catch (err) {
      console.error(`[sessions] tryReconnect: ${logUser(userId)} — error:`, err);
    }

    return null;
  }

  /** Expose the database for shared use (e.g. OAuth tables) */
  getDb(): Database.Database {
    return this.db;
  }

  /**
   * Test-only helper: number of pending lock entries (should be 0 when no operations are
   * in flight). Underscore prefix + `@internal` keep this off public API surface.
   * @internal
   */
  _getPendingLockCount(): number {
    return this.locks.size;
  }

  close(): void {
    this.db.close();
  }
}
