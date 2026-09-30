import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { hashToken, isHashedToken } from "./crypto.js";
import { logger, logUser } from "./logger.js";
import { redirectOrigin } from "./redirect-origin.js";

/** OAuth 2.0 Authorization Server for MCP (RFC 8414, RFC 7591, RFC 7636) */

// 10 years — effectively "no expiry" so MCP clients (Claude Code, ChatGPT) never get a "Needs
// Auth" prompt purely because the access token expired. Some clients don't persist refresh_token
// reliably (observed: Claude Code keychain schema lacks the field), so a short access TTL turns
// into "user re-authenticates every hour" instead of "client transparently refreshes". Refresh
// flow is kept as a safety net; revoke via /oauth/revoke remains the off-switch.
const ACCESS_TOKEN_TTL_SECONDS = 10 * 365 * 24 * 3600;
const AUTH_CODE_TTL_SECONDS = 600; // 10 min — single-use, exchanged immediately by clients
// Window during which a "replay" of a freshly rotated token is treated as a network retry
// (e.g. client received our 200 then network dropped before persisting it). Real attacks land
// hours/days/weeks later; legitimate retries land in milliseconds.
const CONCURRENT_REFRESH_WINDOW_SECONDS = 10;
// A QR login hands the page a one-time ticket that the page trades for the session cookie
// right away; two minutes covers a slow phone without leaving a long-lived secret around.
const BROWSER_HANDOFF_TTL_SECONDS = 120;

// Short, irreversible identifier suitable for log correlation across replay events without
// leaking the secret. SHA-256 truncated to 16 hex chars = 64 bits. Birthday collision
// probability is ~50% at √(2^64) ≈ 4B tokens — overkill for our forensics audit window
// (≤90 days; current rate ≪ 100K tokens/day) and irreversible regardless of length.
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export interface OAuthConfig {
  issuer: string; // public base URL (e.g. "https://your-host.example")
  db: Database;
}

interface RegisteredClient {
  client_id: string;
  client_secret: string | null;
  redirect_uris: string;
  client_name: string;
}

interface AuthCode {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
}

interface AccessToken {
  access_token: string;
  client_id: string;
  user_id: string;
  expires_at: number;
}

export class OAuthProvider {
  private db: Database;
  private issuer: string;

  constructor(config: OAuthConfig) {
    this.db = config.db;
    this.issuer = config.issuer;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        redirect_uris TEXT NOT NULL,
        client_name TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL DEFAULT 'S256',
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        access_token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        refresh_token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_user_id ON oauth_refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at ON oauth_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires_at ON oauth_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_expires_at ON oauth_refresh_tokens(expires_at);
      -- Which callback destinations a user has knowingly connected. Gates the
      -- silent /oauth/authorize fast path: without a grant the user is asked to
      -- confirm, so a link to a stranger's freshly registered client can no
      -- longer mint a code out of an ambient cookie. Keyed by redirect ORIGIN,
      -- not client_id -- see src/redirect-origin.ts for why.
      CREATE TABLE IF NOT EXISTS oauth_grants (
        user_id TEXT NOT NULL,
        redirect_origin TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, redirect_origin)
      );

      -- Browser sessions (the tg_sid cookie). Before these existed the browser
      -- identified itself with a tg_user cookie holding the plain username, so
      -- anyone could claim any account by sending that cookie. A session is only
      -- minted after the server itself saw the proof: a finished QR login (via a
      -- one-time handoff) or a valid review token. Both tables store hashes only.
      CREATE TABLE IF NOT EXISTS browser_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_user ON browser_sessions(user_id);
      CREATE TABLE IF NOT EXISTS browser_handoffs (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);

    // Idempotent migration: refresh-token rotation + replay detection (v2.23.0).
    // expires_at = 0 marks "never expires" for tokens issued under the new scheme;
    // pre-migration tokens keep their original expires_at and auto-upgrade on next refresh.
    // SQLite ALTER TABLE ADD COLUMN is itself transactional and back-fills NOT NULL DEFAULTs
    // safely on populated tables, but wrapping all DDL in one transaction keeps the schema
    // shape consistent across crashes mid-migration.
    //
    // Forward-only by design. Rolling back the deployment to v2.22 leaves the new columns in
    // the DB (harmless — old code does column-list INSERTs and SELECT *), BUT v2.22's
    // cleanup() deletes any row with `expires_at < now`, including v2.23's `expires_at = 0`
    // sentinels. A rollback therefore wipes every never-expiring refresh token at the next
    // cleanup tick. Document operationally: rollbacks require a DB snapshot restore.
    this.db.transaction(() => {
      const cols = this.db.prepare("PRAGMA table_info(oauth_refresh_tokens)").all() as Array<{ name: string }>;
      const have = new Set(cols.map((c) => c.name));
      if (!have.has("chain_id")) {
        this.db.exec("ALTER TABLE oauth_refresh_tokens ADD COLUMN chain_id TEXT NOT NULL DEFAULT ''");
      }
      if (!have.has("revoked")) {
        this.db.exec("ALTER TABLE oauth_refresh_tokens ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0");
      }
      if (!have.has("replaced_by")) {
        this.db.exec("ALTER TABLE oauth_refresh_tokens ADD COLUMN replaced_by TEXT");
      }
      if (!have.has("revoked_at")) {
        this.db.exec("ALTER TABLE oauth_refresh_tokens ADD COLUMN revoked_at INTEGER NOT NULL DEFAULT 0");
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_chain_id ON oauth_refresh_tokens(chain_id)");
    })();
  }

  /** RFC 8414 — Authorization Server Metadata */
  getMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp:read"],
    };
  }

  /** RFC 7591 — Dynamic Client Registration */
  registerClient(body: { redirect_uris: string[]; client_name?: string }): Record<string, unknown> {
    const clientId = randomBytes(16).toString("hex");
    const clientSecret = randomBytes(32).toString("hex");

    // Store the hash only. The plaintext secret is returned once to the client below (RFC
    // 7591). Our token endpoint uses PKCE — client_secret is currently never verified — but
    // hashing it keeps a stolen cloud.db free of any reusable secret regardless.
    this.db
      .prepare("INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, client_name) VALUES (?, ?, ?, ?)")
      .run(clientId, hashToken(clientSecret), JSON.stringify(body.redirect_uris), body.client_name ?? "");

    logger.info(`OAuth client registered: ${body.client_name || clientId}`, {
      component: "oauth",
      event: "oauth.register",
      clientId,
      client: body.client_name ?? "",
    });

    return {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: body.redirect_uris,
      client_name: body.client_name ?? "",
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  /** Get registered client */
  getClient(clientId: string): RegisteredClient | undefined {
    return this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | RegisteredClient
      | undefined;
  }

  /**
   * Remember that `userId` knowingly connected this callback destination.
   * Called from the explicit-approval route and from every token issue, so the
   * table self-populates for active users instead of needing a data migration.
   */
  recordGrant(userId: string, redirectOriginKey: string): void {
    if (!userId || !redirectOriginKey) return;
    this.db
      .prepare("INSERT OR IGNORE INTO oauth_grants (user_id, redirect_origin) VALUES (?, ?)")
      .run(userId, redirectOriginKey);
  }

  /** Convenience wrapper: derive the origin key from a full redirect URI. */
  recordGrantForRedirect(userId: string, redirectUri: string): void {
    const originKey = redirectOrigin(redirectUri);
    if (originKey) this.recordGrant(userId, originKey);
  }

  /**
   * Has this user already connected this callback destination?
   *
   * Two sources, deliberately:
   *  1. `oauth_grants` \u2014 explicit, written on approval and on token issue.
   *  2. Live tokens \u2014 the GRANDFATHER clause. At the moment this ships, nobody
   *     has a row in (1), yet every current user already trusted their client;
   *     asking them all to re-confirm would be a self-inflicted outage. A user
   *     holding an access or refresh token for a client that points at this
   *     origin has demonstrably completed the flow before, so it counts.
   *
   * The grandfather clause stays permanently rather than as a one-off backfill:
   * `cleanup()` deletes expired access tokens, and a user whose grant row was
   * somehow lost but who still holds a working refresh token must not be
   * bounced through a confirmation screen mid-session.
   */
  hasGrant(userId: string, redirectOriginKey: string): boolean {
    if (!userId || !redirectOriginKey) return false;

    const explicit = this.db
      .prepare("SELECT 1 FROM oauth_grants WHERE user_id = ? AND redirect_origin = ? LIMIT 1")
      .get(userId, redirectOriginKey);
    if (explicit) return true;

    // Origins live inside a JSON array column, so the comparison happens in JS.
    // Bounded by the number of DISTINCT clients this one user holds tokens for.
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.redirect_uris AS uris
           FROM oauth_clients c
          WHERE c.client_id IN (SELECT client_id FROM oauth_tokens WHERE user_id = ?)
             OR c.client_id IN (SELECT client_id FROM oauth_refresh_tokens WHERE user_id = ? AND revoked = 0)`,
      )
      .all(userId, userId) as Array<{ uris: string }>;

    for (const row of rows) {
      let uris: unknown;
      try {
        uris = JSON.parse(row.uris);
      } catch {
        continue;
      }
      if (!Array.isArray(uris)) continue;
      for (const uri of uris) {
        if (typeof uri !== "string") continue;
        if (redirectOrigin(uri) === redirectOriginKey) return true;
      }
    }
    return false;
  }

  /** Total registered clients — used to enforce the registration ceiling. */
  clientCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n;
  }

  /**
   * Prune clients that registered more than `olderThanDays` ago and never
   * obtained a token (no row in oauth_tokens / oauth_refresh_tokens / oauth_codes
   * references them). Unauthenticated DCR lets bots flood this table — most rows
   * are never used (audit H2). Returns the number deleted.
   *
   * A client with any live or historical token is kept: a user who authorized
   * months ago and still holds a refresh token must keep their client row.
   */
  pruneUnusedClients(olderThanDays: number): number {
    if (olderThanDays <= 0) return 0;
    const cutoff = `-${Math.floor(olderThanDays)} days`;
    const result = this.db
      .prepare(
        `DELETE FROM oauth_clients
         WHERE created_at < datetime('now', ?)
           AND client_id NOT IN (SELECT client_id FROM oauth_tokens)
           AND client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens)
           AND client_id NOT IN (SELECT client_id FROM oauth_codes)`,
      )
      .run(cutoff);
    if (result.changes > 0) {
      logger.info(`Pruned ${result.changes} unused oauth_clients (older than ${olderThanDays}d, never authorized)`, {
        component: "oauth",
        event: "oauth.clients.pruned",
        count: result.changes,
      });
    }
    return result.changes;
  }

  /**
   * One-time ticket that turns a server-side QR login into a browser session.
   *
   * The QR login finishes inside an SSE stream whose headers are already sent,
   * so it cannot set a cookie itself. It hands this ticket to the page, and the
   * page trades it for the session cookie. Short-lived and single-use.
   */
  createBrowserHandoff(userId: string): string {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + BROWSER_HANDOFF_TTL_SECONDS;
    this.db
      .prepare("INSERT INTO browser_handoffs (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(token), userId, expiresAt);
    return token;
  }

  /** Consume a handoff ticket: the user it was minted for, or null. The ticket is gone either way. */
  redeemBrowserHandoff(token: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT user_id, expires_at FROM browser_handoffs WHERE token_hash = ?").get(hash) as
        | { user_id: string; expires_at: number }
        | undefined;
      this.db.prepare("DELETE FROM browser_handoffs WHERE token_hash = ?").run(hash);
      if (!row || row.expires_at < now) return null;
      return row.user_id;
    })();
  }

  /** Start a browser session for a user the server has verified. Returns the cookie value. */
  createBrowserSession(userId: string, maxAgeSeconds: number): string {
    const token = randomBytes(32).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare("INSERT INTO browser_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), userId, now + maxAgeSeconds, now);
    return token;
  }

  /** The user behind a browser session cookie value, or null when unknown or expired. */
  getBrowserSessionUser(token: string | undefined): string | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = this.db
      .prepare("SELECT user_id FROM browser_sessions WHERE token_hash = ? AND expires_at >= ?")
      .get(hashToken(token), Math.floor(Date.now() / 1000)) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  /** Create authorization code (after user approves) */
  createAuthCode(params: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  }): string {
    const code = randomBytes(32).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS;

    // Store the hash; the plaintext code is returned to the client and matched via dual-read
    // on exchange. Codes are single-use and short-lived (10 min) but hashing keeps the
    // at-rest invariant uniform across all OAuth secrets.
    this.db
      .prepare(
        "INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        hashToken(code),
        params.clientId,
        params.userId,
        params.redirectUri,
        params.codeChallenge,
        params.codeChallengeMethod,
        expiresAt,
      );

    return code;
  }

  /** Exchange authorization code for access token + refresh token */
  exchangeCode(params: {
    code: string;
    clientId: string;
    codeVerifier: string;
    redirectUri: string;
  }): { access_token: string; token_type: string; expires_in: number; refresh_token: string } | null {
    // Dual-read: hashed row (current) or legacy plaintext. Client sends the plaintext code.
    const row = this.db
      .prepare("SELECT * FROM oauth_codes WHERE code = ? OR code = ?")
      .get(hashToken(params.code), params.code) as AuthCode | undefined;

    if (!row) return null;

    // Delete used code (one-time use) — by the value actually stored.
    this.db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(row.code);

    // Check expiry
    if (row.expires_at < Math.floor(Date.now() / 1000)) return null;

    // Check client_id
    if (row.client_id !== params.clientId) return null;

    // Check redirect_uri
    if (row.redirect_uri !== params.redirectUri) return null;

    // Verify PKCE
    if (!this.verifyPKCE(params.codeVerifier, row.code_challenge, row.code_challenge_method)) {
      return null;
    }

    // The user completed a full authorization for this destination \u2014 record it so
    // the next visit takes the silent fast path instead of a confirmation screen.
    this.recordGrantForRedirect(row.user_id, row.redirect_uri);

    return this.issueTokenPair(row.client_id, row.user_id, randomBytes(16).toString("hex"));
  }

  /**
   * Refresh an access token using a refresh token.
   *
   * Implements rotation with replay detection (RFC 6749 §10.4 / OAuth 2.1):
   *   - On first use: mark this token as `revoked`, stamp `replaced_by = <new>` and
   *     `revoked_at`, issue a new refresh_token in the same `chain_id`. The new token never
   *     expires. The UPDATE-old + INSERT-new pair runs in a single SQLite transaction so a
   *     crash between them cannot strand the chain.
   *   - On reuse of an already-rotated token within `CONCURRENT_REFRESH_WINDOW_SECONDS`:
   *     treated as a benign network retry (returns `null` without revoking the chain) and
   *     logged as `oauth.token.refresh_concurrent`.
   *   - On reuse of an already-rotated token after that window: the entire chain is suspect
   *     — revoke every refresh_token in the chain and every access_token of (user, client),
   *     return `null`, emit `oauth.token.replay_detected`.
   *
   * Tokens issued before v2.23.0 (no chain_id, finite expires_at) are accepted on first
   * refresh and auto-upgraded into a fresh never-expiring chain. The legacy row is also
   * stamped with the new chain_id so that a later replay of the legacy token is correctly
   * traced back to the upgraded chain.
   */
  refreshAccessToken(params: {
    refreshToken: string;
    clientId: string;
  }): { access_token: string; token_type: string; expires_in: number; refresh_token: string } | null {
    // Two HTTP requests can interleave between any non-transactional SELECT and the rotation
    // write. To avoid issuing two successor tokens in the same chain, we do a SELECT inside
    // the transaction AND use an atomic compare-and-set UPDATE (`WHERE refresh_token = ? AND
    // revoked = 0 RETURNING ...`) so only the first arrival actually claims the rotation —
    // the second arrival's UPDATE matches zero rows and re-reads the row to decide between
    // "concurrent retry" (within window) and "replay" (outside window).
    const now = Math.floor(Date.now() / 1000);
    const tokenFingerprint = fingerprint(params.refreshToken);
    const newRefresh = randomBytes(32).toString("hex");

    type Row = {
      refresh_token: string;
      client_id: string;
      user_id: string;
      expires_at: number;
      chain_id: string;
      revoked: number;
      replaced_by: string | null;
      revoked_at: number;
    };

    type Outcome =
      | { kind: "rotated"; userId: string; clientId: string; chainId: string; accessToken: string }
      | { kind: "replay"; row: Row }
      | { kind: "concurrent"; row: Row; ageSeconds: number }
      | { kind: "reject" }
      | { kind: "not_found" };

    const hashedRefresh = hashToken(params.refreshToken);
    const outcome: Outcome = this.db
      .transaction((): Outcome => {
        // Dual-read: hashed row (current) or legacy plaintext. Client sends plaintext.
        const row = this.db
          .prepare("SELECT * FROM oauth_refresh_tokens WHERE refresh_token = ? OR refresh_token = ?")
          .get(hashedRefresh, params.refreshToken) as Row | undefined;
        if (!row) return { kind: "not_found" };
        if (row.client_id !== params.clientId) return { kind: "reject" };

        // Already rotated / explicitly revoked — classify retry vs replay outside the txn.
        if (row.revoked || row.replaced_by) {
          const ageSeconds = row.revoked_at > 0 ? now - row.revoked_at : -1;
          if (ageSeconds >= 0 && ageSeconds <= CONCURRENT_REFRESH_WINDOW_SECONDS) {
            return { kind: "concurrent", row, ageSeconds };
          }
          return { kind: "replay", row };
        }

        // Pre-v2.23 tokens used finite expiry. After migration, expires_at=0 means never expires.
        if (row.expires_at !== 0 && row.expires_at < now) return { kind: "reject" };

        // Legacy rows have no chain_id. Allocate one now so revokeChain() can find every sibling
        // if this chain is later replayed (the UPDATE below stamps the legacy old row too).
        const chainId = row.chain_id || randomBytes(16).toString("hex");

        // Compare-and-set: only the first arrival flips the row from revoked = 0 → 1. A second
        // caller racing on the same refresh_token (Node single-threaded but HTTP handlers are
        // async — two requests can both pass the SELECT before either runs UPDATE) gets zero
        // matched rows because revoked is already 1, and falls into the !claimed branch below.
        // The outer transaction is started with `.immediate()` (BEGIN IMMEDIATE) so all writes
        // serialize at the database level rather than relying on optimistic deferred locking.
        // `replaced_by` is hashed too — it points at the successor refresh_token, which is
        // stored hashed by issueTokenPair, so the pointer matches the column it references.
        // WHERE matches the value actually stored (row.refresh_token from the dual-read above).
        const claimed = this.db
          .prepare(
            "UPDATE oauth_refresh_tokens SET revoked = 1, replaced_by = ?, revoked_at = ?, chain_id = ? WHERE refresh_token = ? AND revoked = 0 RETURNING refresh_token",
          )
          .get(hashToken(newRefresh), now, chainId, row.refresh_token) as { refresh_token: string } | undefined;

        if (!claimed) {
          // Lost the race against another concurrent caller that already rotated this row.
          // Treat as a benign retry — caller will see null and the legitimate first caller
          // already received the new pair.
          return { kind: "concurrent", row, ageSeconds: 0 };
        }

        const issued = this.issueTokenPair(row.client_id, row.user_id, chainId, newRefresh);
        return {
          kind: "rotated",
          userId: row.user_id,
          clientId: row.client_id,
          chainId,
          accessToken: issued.access_token,
        };
      })
      .immediate();

    switch (outcome.kind) {
      case "not_found":
      case "reject":
        return null;

      case "concurrent": {
        logger.info(`OAuth refresh concurrent retry for ${logUser(outcome.row.user_id)}`, {
          component: "oauth",
          event: "oauth.token.refresh_concurrent",
          userId: logUser(outcome.row.user_id),
          clientId: outcome.row.client_id,
          chainId: outcome.row.chain_id,
          ageSeconds: outcome.ageSeconds,
          tokenFingerprint,
        });
        return null;
      }

      case "replay": {
        const ageSeconds = outcome.row.revoked_at > 0 ? now - outcome.row.revoked_at : -1;
        // If this row has no chain_id (truly stranded legacy that was somehow marked revoked
        // without ever being rotated), revokeChain on '' would no-op the chain UPDATE; fall
        // back to revoking THIS specific row plus the user's access tokens for the client.
        this.revokeChain(
          outcome.row.chain_id,
          outcome.row.user_id,
          outcome.row.client_id,
          "replay",
          outcome.row.refresh_token,
        );
        logger.warn(`OAuth refresh token replay detected for ${logUser(outcome.row.user_id)}`, {
          component: "oauth",
          event: "oauth.token.replay_detected",
          userId: logUser(outcome.row.user_id),
          clientId: outcome.row.client_id,
          chainId: outcome.row.chain_id,
          ageSeconds,
          tokenFingerprint,
          wasMidChain: outcome.row.replaced_by ? 1 : 0,
        });
        return null;
      }

      case "rotated": {
        logger.info(`OAuth token refreshed for ${logUser(outcome.userId)}`, {
          component: "oauth",
          event: "oauth.token.refresh",
          userId: logUser(outcome.userId),
          clientId: outcome.clientId,
          chainId: outcome.chainId,
        });
        return {
          access_token: outcome.accessToken,
          token_type: "Bearer",
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
          refresh_token: newRefresh,
        };
      }
    }
  }

  /**
   * Revoke every refresh_token in a chain plus every active access_token of (user, client).
   * Atomic: if either UPDATE/DELETE fails we don't half-revoke.
   *
   * `fallbackToken` is used when `chainId` is empty (truly stranded legacy row that was
   * marked revoked without ever being rotated, or a manually-injected DB row): we revoke
   * that single refresh-token by primary key so the row can never be reused.
   */
  private revokeChain(chainId: string, userId: string, clientId: string, reason: string, fallbackToken?: string): void {
    let refreshChanges = 0;
    let accessChanges = 0;
    this.db
      .transaction(() => {
        if (chainId) {
          const r = this.db
            .prepare("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE chain_id = ? AND revoked = 0")
            .run(chainId);
          refreshChanges = r.changes;
        } else if (fallbackToken) {
          // Empty chain_id: revoke just this row so the replayed token cannot be reused.
          const r = this.db
            .prepare("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE refresh_token = ? AND revoked = 0")
            .run(fallbackToken);
          refreshChanges = r.changes;
        }
        const a = this.db.prepare("DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?").run(userId, clientId);
        accessChanges = a.changes;
      })
      .immediate();
    logger.info(
      `OAuth chain revoked for ${logUser(userId)}: ${refreshChanges} refresh + ${accessChanges} access cleared`,
      {
        component: "oauth",
        event: "oauth.chain.revoke",
        userId: logUser(userId),
        clientId,
        chainId,
        reason,
        refreshRevoked: refreshChanges,
        accessRevoked: accessChanges,
      },
    );
  }

  /**
   * Issue a new access_token (short-lived) + refresh_token (never expires) bound to a chain.
   * Caller supplies `chainId` (new on auth-code exchange, reused on rotation) and may
   * pre-allocate the refresh-token value when a rotation needs to record `replaced_by`
   * before the new row exists.
   */
  private issueTokenPair(
    clientId: string,
    userId: string,
    chainId: string,
    presetRefreshToken?: string,
  ): { access_token: string; token_type: string; expires_in: number; refresh_token: string } {
    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = presetRefreshToken ?? randomBytes(32).toString("hex");

    // Store only the SHA-256 hash; the plaintext is returned to the client below and never
    // persisted. Lookups hash the incoming token to match (see dual-read helpers).
    this.db
      .prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(accessToken), clientId, userId, Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS);

    // expires_at = 0 ⇒ never expires. Lifetime is bounded by rotation, replay revoke, or
    // explicit /oauth/revoke; cleanup() leaves these rows alone.
    this.db
      .prepare(
        "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, ?, 0, ?)",
      )
      .run(hashToken(refreshToken), clientId, userId, chainId);

    logger.info(`OAuth token issued for ${logUser(userId)}`, {
      component: "oauth",
      event: "oauth.token.issued",
      userId: logUser(userId),
      clientId,
      chainId,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    };
  }

  /** Validate Bearer token, return userId and clientName or null */
  validateToken(token: string): { userId: string; clientName: string } | null {
    // Dual-read: match the hashed row (current scheme) OR a not-yet-migrated legacy
    // plaintext row. The client always sends plaintext; we hash to match the stored hash.
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE access_token = ? OR access_token = ?")
      .get(hashToken(token), token) as AccessToken | undefined;

    if (!row) return null;
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      this.db.prepare("DELETE FROM oauth_tokens WHERE access_token = ?").run(row.access_token);
      return null;
    }

    const client = this.getClient(row.client_id);
    return { userId: row.user_id, clientName: client?.client_name ?? "" };
  }

  /**
   * Revoke a specific token and return the associated user_id (for session cleanup).
   * RFC 7009 — Token Revocation.
   */
  revokeToken(token: string): string | null {
    // Dual-read; delete by the value actually stored (hashed or legacy plaintext).
    const hashed = hashToken(token);
    const row = this.db
      .prepare("SELECT access_token, user_id FROM oauth_tokens WHERE access_token = ? OR access_token = ?")
      .get(hashed, token) as { access_token: string; user_id: string } | undefined;

    if (!row) return null;

    this.db.prepare("DELETE FROM oauth_tokens WHERE access_token = ?").run(row.access_token);
    logger.info(`OAuth token revoked for ${logUser(row.user_id)}`, {
      component: "oauth",
      event: "oauth.token.revoke",
      userId: logUser(row.user_id),
    });
    return row.user_id;
  }

  /**
   * Revoke ALL tokens for a given user_id.
   *
   * Hard-deletes both tables (rather than marking `revoked = 1` like rotation/replay paths)
   * because there is no chain to preserve here: a deleted refresh_token returns null at the
   * SELECT step in `refreshAccessToken`, which is the desired outcome — no chain revoke,
   * no replay alert, just "this token never existed". Used by `/oauth/revoke` and by
   * server-side session-revoked handlers.
   */
  revokeAllUserTokens(userId: string): number {
    const result = this.db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(userId);
    const refreshResult = this.db.prepare("DELETE FROM oauth_refresh_tokens WHERE user_id = ?").run(userId);
    logger.info(
      `All tokens revoked for ${logUser(userId)}: ${result.changes} access + ${refreshResult.changes} refresh`,
      {
        component: "oauth",
        event: "oauth.token.revoke_all",
        userId: logUser(userId),
        count: result.changes + refreshResult.changes,
      },
    );
    return result.changes + refreshResult.changes;
  }

  /** PKCE S256 verification */
  private verifyPKCE(codeVerifier: string, codeChallenge: string, method: string): boolean {
    // S256 only. The `plain` method is deliberately unsupported: with `plain`
    // the challenge equals the verifier, so a leaked authorization code (referer,
    // logs, redirect interception) defeats PKCE entirely. Our metadata advertises
    // only S256 (getMetadata) and /authorize rejects anything else up front; this
    // is the defense-in-depth backstop. An empty challenge/verifier never passes
    // because both must be present and the SHA-256 of "" won't equal "".
    if (method !== "S256") return false;
    if (!codeVerifier || !codeChallenge) return false;
    const hash = createHash("sha256").update(codeVerifier).digest("base64url");
    return hash === codeChallenge;
  }

  /**
   * Cleanup expired codes and tokens.
   *
   * Refresh tokens with `expires_at = 0` (the v2.23.0+ default) are never garbage-collected
   * by time — they live until rotation, replay-revoke, or explicit /oauth/revoke. Pre-v2.23.0
   * tokens still carry a real `expires_at` and are pruned here once stale.
   */
  cleanup(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at != 0 AND expires_at < ?").run(now);
    this.db.prepare("DELETE FROM browser_sessions WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM browser_handoffs WHERE expires_at < ?").run(now);
    // Reap abandoned client registrations (DCR flood). Runs after token cleanup
    // so a client whose only tokens just expired becomes eligible immediately.
    this.pruneUnusedClients(config.unusedClientTtlDays);
  }

  /**
   * One-time backfill: replace any legacy plaintext OAuth secrets with their `h1:` hashes.
   *
   * Covers access_token, refresh_token (+ its `replaced_by` pointer), auth codes, and
   * client_secret. Transparent to clients: they keep sending the same plaintext token and
   * dual-read hashes it on the way in — so an already-migrated row and a not-yet-migrated row
   * both resolve until this sweep finishes the dormant tail.
   *
   * TIMING (same constraint as session encryption): during a `start-first` rolling update the
   * OLD container looks up tokens by raw plaintext and shares this volume. Hashing a row makes
   * the old container's `WHERE token = <plaintext>` miss → spurious "needs auth" for ~drain
   * window. server.tsx defers this ~2 min post-boot, past the old task's 90s drain. New code's
   * dual-read tolerates either form, so no request fails once the new container serves.
   *
   * @returns count of secrets hashed across all tables.
   */
  migrateTokenHashes(): number {
    let migrated = 0;

    const hashColumn = (table: string, col: string, pk: string): void => {
      const rows = this.db.prepare(`SELECT ${pk} AS pk, ${col} AS val FROM ${table}`).all() as Array<{
        pk: string;
        val: string | null;
      }>;
      const upd = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${pk} = ?`);
      for (const r of rows) {
        if (!r.val || isHashedToken(r.val)) continue;
        upd.run(hashToken(r.val), r.pk);
        migrated++;
      }
    };

    this.db.transaction(() => {
      hashColumn("oauth_tokens", "access_token", "access_token");
      hashColumn("oauth_refresh_tokens", "refresh_token", "refresh_token");
      hashColumn("oauth_codes", "code", "code");
      hashColumn("oauth_clients", "client_secret", "client_id");
      // `replaced_by` points at a successor refresh_token (now stored hashed). Upgrade any
      // legacy plaintext pointer so chain forensics stays consistent. Keyed by refresh_token
      // (already hashed by the sweep above, so match on the hashed PK).
      const ptrs = this.db
        .prepare(
          "SELECT refresh_token AS pk, replaced_by AS val FROM oauth_refresh_tokens WHERE replaced_by IS NOT NULL",
        )
        .all() as Array<{ pk: string; val: string }>;
      const updPtr = this.db.prepare("UPDATE oauth_refresh_tokens SET replaced_by = ? WHERE refresh_token = ?");
      for (const r of ptrs) {
        if (!r.val || isHashedToken(r.val)) continue;
        updPtr.run(hashToken(r.val), r.pk);
        migrated++;
      }
    })();

    return migrated;
  }
}
