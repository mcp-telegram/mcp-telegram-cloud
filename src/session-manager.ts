import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { TelegramService } from "@overpod/mcp-telegram/service";
import { config } from "./config.js";
import { logUser } from "./logger.js";

interface UserSession {
  telegram: TelegramService;
  connectedAt: Date;
  lastActivity: Date;
}

export interface TelegramAccount {
  accountId: number;
  ownerUserId: string;
  telegramUserId: string;
  label: string | null;
  addedAt: string;
  lastUsedAt: string;
}

export interface AccountSummary {
  /** 0 = primary (lives in user_sessions); >0 = secondary (in telegram_accounts). */
  accountId: number;
  /** Telegram username or numeric id — same shape that the primary user_id uses. */
  telegramUserId: string;
  label: string | null;
  isPrimary: boolean;
  isActive: boolean;
  addedAt: string | null;
  lastUsedAt: string | null;
}

/** Pool key for non-primary accounts. Two accounts of the same owner must NOT collide
 *  with each other or with the primary slot (which keys by raw `ownerUserId`). */
const secondaryKey = (ownerUserId: string, accountId: number): string => `${ownerUserId}#${accountId}`;

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
  private db: Database;

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
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        user_id TEXT PRIMARY KEY,
        session_string TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // v2.32.0 multi-account: secondary Telegram accounts attached to a primary
    // owner_user_id. owner_user_id is the original `user_sessions.user_id` —
    // i.e. the Telegram identity that completed the OAuth flow. Primary account
    // is implicit (lives in user_sessions); secondary accounts live here.
    //
    // active_account.account_id = 0  ⇒  primary (default, backward-compatible)
    // active_account.account_id > 0  ⇒  telegram_accounts.account_id
    //
    // add_tokens are short-lived capabilities issued by `accounts-add` so the
    // owner can finish QR login on a different device. The token is the auth —
    // anyone who opens the URL adds a Telegram account to this owner_user_id.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_accounts (
        account_id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        telegram_user_id TEXT NOT NULL,
        session_string TEXT NOT NULL,
        label TEXT,
        added_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT DEFAULT (datetime('now')),
        UNIQUE(owner_user_id, telegram_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_accounts_owner ON telegram_accounts(owner_user_id);

      CREATE TABLE IF NOT EXISTS active_account (
        owner_user_id TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL DEFAULT 0,
        switched_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS add_account_tokens (
        token TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        label TEXT,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_add_account_tokens_expires ON add_account_tokens(expires_at);
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
    // v2.32.0 multi-account: if owner has a non-primary active account, route reads/writes
    // through that account's TelegramService instead of the primary. Pool key for secondary
    // accounts is `${ownerUserId}#${accountId}` so two accounts of the same owner never
    // share a `UserSession` slot.
    const activeId = this.getActiveAccountId(userId);
    if (activeId > 0) {
      const session = this.sessions.get(secondaryKey(userId, activeId));
      if (session) {
        session.lastActivity = new Date();
      }
      return session?.telegram;
    }
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

    // v2.32.0: also wipe multi-account state for this owner.
    this.deleteSecondariesForOwner(userId);

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
  // ──────────────────────────────────────────────────────────────────────────
  // v2.32.0 multi-account API.
  //
  // Concept: every OAuth-authenticated `ownerUserId` has one *primary* Telegram
  // account (the one that completed the OAuth QR flow, lives in `user_sessions`)
  // plus zero or more *secondary* accounts (live in `telegram_accounts`). At any
  // moment exactly one is "active" — that's the one `getSession(ownerUserId)`
  // returns. Switching is a row update in `active_account`; existing tool
  // dispatch needs no changes because it always goes through `getSession`.
  // ──────────────────────────────────────────────────────────────────────────

  /** 0 = primary active (default for owners with no row in `active_account`). */
  getActiveAccountId(ownerUserId: string): number {
    const row = this.db.prepare("SELECT account_id FROM active_account WHERE owner_user_id = ?").get(ownerUserId) as
      | { account_id: number }
      | undefined;
    return row?.account_id ?? 0;
  }

  /** List primary + secondaries for one owner with `isActive` indicator. */
  listAccounts(ownerUserId: string): AccountSummary[] {
    const activeId = this.getActiveAccountId(ownerUserId);
    const result: AccountSummary[] = [];

    // Primary: the OAuth-authenticated identity itself.
    const primary = this.db
      .prepare("SELECT user_id, created_at, updated_at FROM user_sessions WHERE user_id = ?")
      .get(ownerUserId) as { user_id: string; created_at: string; updated_at: string } | undefined;
    if (primary) {
      result.push({
        accountId: 0,
        telegramUserId: primary.user_id,
        label: null,
        isPrimary: true,
        isActive: activeId === 0,
        addedAt: primary.created_at,
        lastUsedAt: primary.updated_at,
      });
    }

    const rows = this.db
      .prepare(
        "SELECT account_id, telegram_user_id, label, added_at, last_used_at FROM telegram_accounts WHERE owner_user_id = ? ORDER BY account_id",
      )
      .all(ownerUserId) as Array<{
      account_id: number;
      telegram_user_id: string;
      label: string | null;
      added_at: string;
      last_used_at: string;
    }>;
    for (const r of rows) {
      result.push({
        accountId: r.account_id,
        telegramUserId: r.telegram_user_id,
        label: r.label,
        isPrimary: false,
        isActive: activeId === r.account_id,
        addedAt: r.added_at,
        lastUsedAt: r.last_used_at,
      });
    }

    return result;
  }

  /**
   * Resolve a user-supplied identifier (label, telegram username with/without `@`,
   * numeric account_id, or the literal "primary") to an account row this owner can
   * switch to. Returns `null` if no match. Match is case-insensitive on label and
   * username. Numeric must be exact.
   */
  resolveAccount(ownerUserId: string, identifier: string): AccountSummary | null {
    const accounts = this.listAccounts(ownerUserId);
    const norm = identifier.trim().replace(/^@/, "").toLowerCase();
    if (norm === "primary" || norm === "0") return accounts.find((a) => a.isPrimary) ?? null;
    const asNum = Number.parseInt(norm, 10);
    if (Number.isInteger(asNum) && asNum > 0) {
      return accounts.find((a) => a.accountId === asNum) ?? null;
    }
    return (
      accounts.find(
        (a) => (a.label !== null && a.label.toLowerCase() === norm) || a.telegramUserId.toLowerCase() === norm,
      ) ?? null
    );
  }

  /** Switch the owner's active account. account_id=0 means "back to primary". */
  setActiveAccount(ownerUserId: string, accountId: number): void {
    if (accountId !== 0) {
      const exists = this.db
        .prepare("SELECT 1 FROM telegram_accounts WHERE owner_user_id = ? AND account_id = ?")
        .get(ownerUserId, accountId);
      if (!exists) throw new Error(`Account ${accountId} not found for owner ${logUser(ownerUserId)}`);
    }
    this.db
      .prepare(
        `INSERT INTO active_account (owner_user_id, account_id, switched_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(owner_user_id) DO UPDATE SET account_id = excluded.account_id, switched_at = excluded.switched_at`,
      )
      .run(ownerUserId, accountId);
    if (accountId > 0) {
      this.db
        .prepare("UPDATE telegram_accounts SET last_used_at = datetime('now') WHERE account_id = ?")
        .run(accountId);
    }
  }

  /**
   * Add a secondary Telegram account for this owner. Called from the add-account
   * QR-flow after a successful login. Idempotent on `(owner_user_id, telegram_user_id)`
   * — re-adding the same Telegram identity updates the session_string and label.
   * Returns the resulting account_id (new or existing).
   */
  addAccount(ownerUserId: string, telegramUserId: string, sessionString: string, label: string | null): number {
    const existing = this.db
      .prepare("SELECT account_id FROM telegram_accounts WHERE owner_user_id = ? AND telegram_user_id = ?")
      .get(ownerUserId, telegramUserId) as { account_id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          "UPDATE telegram_accounts SET session_string = ?, label = ?, last_used_at = datetime('now') WHERE account_id = ?",
        )
        .run(sessionString, label, existing.account_id);
      return existing.account_id;
    }

    const result = this.db
      .prepare(
        "INSERT INTO telegram_accounts (owner_user_id, telegram_user_id, session_string, label) VALUES (?, ?, ?, ?)",
      )
      .run(ownerUserId, telegramUserId, sessionString, label);
    return Number(result.lastInsertRowid);
  }

  /**
   * Remove a secondary account. If it was active, fall back to primary (0).
   * The primary account is NOT removable here — `destroyUserSession` is the
   * only path that revokes the OAuth identity itself.
   */
  removeAccount(ownerUserId: string, accountId: number): boolean {
    if (accountId === 0) throw new Error("Cannot remove primary account via removeAccount — use destroyUserSession");
    const result = this.db
      .prepare("DELETE FROM telegram_accounts WHERE owner_user_id = ? AND account_id = ?")
      .run(ownerUserId, accountId);
    if (result.changes === 0) return false;
    // Drop the live session from pool (fire-and-forget disconnect).
    const key = secondaryKey(ownerUserId, accountId);
    const pooled = this.sessions.get(key);
    if (pooled) {
      this.sessions.delete(key);
      pooled.telegram.disconnect().catch(() => {});
    }
    // Demote active if this was the active one.
    if (this.getActiveAccountId(ownerUserId) === accountId) {
      this.setActiveAccount(ownerUserId, 0);
    }
    return true;
  }

  /**
   * Ensure the live session for the owner's currently-active account is in the
   * pool. Primary path delegates to `getOrCreateSession(ownerUserId)` (which
   * looks at `user_sessions`); secondary path looks up the account row, creates
   * a fresh `TelegramService`, sets the session string and connects.
   *
   * Pool key for secondary is `secondaryKey(ownerUserId, accountId)`.
   */
  async ensureActiveSession(ownerUserId: string): Promise<TelegramService> {
    const accountId = this.getActiveAccountId(ownerUserId);
    if (accountId === 0) return this.getOrCreateSession(ownerUserId);
    const key = secondaryKey(ownerUserId, accountId);
    return this.withLock(key, async () => {
      const pooled = this.sessions.get(key);
      if (pooled) {
        pooled.lastActivity = new Date();
        if (!pooled.telegram.isConnected()) await pooled.telegram.ensureConnected();
        return pooled.telegram;
      }
      const row = this.db
        .prepare("SELECT session_string FROM telegram_accounts WHERE owner_user_id = ? AND account_id = ?")
        .get(ownerUserId, accountId) as { session_string: string } | undefined;
      if (!row?.session_string) {
        // Account disappeared from under us — demote to primary so we don't
        // wedge tool dispatch.
        this.setActiveAccount(ownerUserId, 0);
        return this.getOrCreateSession(ownerUserId);
      }
      const telegram = this.telegramFactory(this.apiId, this.apiHash);
      telegram.setSessionString(row.session_string);
      const connected = await telegram.connect();
      if (connected) {
        this.sessions.set(key, { telegram, connectedAt: new Date(), lastActivity: new Date() });
      }
      return telegram;
    });
  }

  // ── add-account capability tokens ────────────────────────────────────────

  /** Create a one-time short-lived URL token allowing QR-login that attaches a new
   *  Telegram identity to `ownerUserId`. The token IS the auth — keep TTL short. */
  createAddAccountToken(ownerUserId: string, label: string | null, ttlSeconds: number): string {
    const token = randomBytes(24).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    this.db
      .prepare("INSERT INTO add_account_tokens (token, owner_user_id, label, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, ownerUserId, label, expiresAt);
    return token;
  }

  /** Validate an add-account token without consuming it (for GET page render). */
  peekAddAccountToken(token: string): { ownerUserId: string; label: string | null } | null {
    const row = this.db
      .prepare("SELECT owner_user_id, label, expires_at, used FROM add_account_tokens WHERE token = ?")
      .get(token) as { owner_user_id: string; label: string | null; expires_at: number; used: number } | undefined;
    if (!row) return null;
    if (row.used === 1) return null;
    if (row.expires_at < Math.floor(Date.now() / 1000)) return null;
    return { ownerUserId: row.owner_user_id, label: row.label };
  }

  /** Consume an add-account token (single-use). Returns the owner/label on success. */
  consumeAddAccountToken(token: string): { ownerUserId: string; label: string | null } | null {
    const peeked = this.peekAddAccountToken(token);
    if (!peeked) return null;
    const result = this.db.prepare("UPDATE add_account_tokens SET used = 1 WHERE token = ? AND used = 0").run(token);
    if (result.changes === 0) return null;
    return peeked;
  }

  /** Periodic cleanup — drop expired / used add-account tokens older than a day. */
  pruneAddAccountTokens(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare("DELETE FROM add_account_tokens WHERE expires_at < ? OR used = 1").run(now);
    return result.changes;
  }

  /**
   * On destroyUserSession, also delete this owner's secondary accounts. Caller
   * runs inside the per-user lock so this is safe to perform inline.
   */
  private deleteSecondariesForOwner(ownerUserId: string): void {
    const rows = this.db
      .prepare("SELECT account_id FROM telegram_accounts WHERE owner_user_id = ?")
      .all(ownerUserId) as Array<{ account_id: number }>;
    for (const { account_id } of rows) {
      const key = secondaryKey(ownerUserId, account_id);
      const pooled = this.sessions.get(key);
      if (pooled) {
        this.sessions.delete(key);
        pooled.telegram.disconnect().catch(() => {});
      }
    }
    this.db.prepare("DELETE FROM telegram_accounts WHERE owner_user_id = ?").run(ownerUserId);
    this.db.prepare("DELETE FROM active_account WHERE owner_user_id = ?").run(ownerUserId);
    this.db.prepare("DELETE FROM add_account_tokens WHERE owner_user_id = ?").run(ownerUserId);
  }

  getDb(): Database {
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
