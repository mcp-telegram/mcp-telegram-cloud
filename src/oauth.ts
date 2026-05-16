import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { logger, logUser } from "./logger.js";

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

    this.db
      .prepare("INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, client_name) VALUES (?, ?, ?, ?)")
      .run(clientId, clientSecret, JSON.stringify(body.redirect_uris), body.client_name ?? "");

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

    this.db
      .prepare(
        "INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        code,
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
    const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(params.code) as AuthCode | undefined;

    if (!row) return null;

    // Delete used code (one-time use)
    this.db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(params.code);

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

    const outcome: Outcome = this.db
      .transaction((): Outcome => {
        const row = this.db
          .prepare("SELECT * FROM oauth_refresh_tokens WHERE refresh_token = ?")
          .get(params.refreshToken) as Row | undefined;
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
        const claimed = this.db
          .prepare(
            "UPDATE oauth_refresh_tokens SET revoked = 1, replaced_by = ?, revoked_at = ?, chain_id = ? WHERE refresh_token = ? AND revoked = 0 RETURNING refresh_token",
          )
          .get(newRefresh, now, chainId, params.refreshToken) as { refresh_token: string } | undefined;

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

    this.db
      .prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(accessToken, clientId, userId, Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS);

    // expires_at = 0 ⇒ never expires. Lifetime is bounded by rotation, replay revoke, or
    // explicit /oauth/revoke; cleanup() leaves these rows alone.
    this.db
      .prepare(
        "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, ?, 0, ?)",
      )
      .run(refreshToken, clientId, userId, chainId);

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
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE access_token = ?").get(token) as
      | AccessToken
      | undefined;

    if (!row) return null;
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      this.db.prepare("DELETE FROM oauth_tokens WHERE access_token = ?").run(token);
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
    const row = this.db.prepare("SELECT user_id FROM oauth_tokens WHERE access_token = ?").get(token) as
      | { user_id: string }
      | undefined;

    if (!row) return null;

    this.db.prepare("DELETE FROM oauth_tokens WHERE access_token = ?").run(token);
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
    if (method === "S256") {
      const hash = createHash("sha256").update(codeVerifier).digest("base64url");
      return hash === codeChallenge;
    }
    // plain (not recommended, but spec-compliant)
    return codeVerifier === codeChallenge;
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
  }
}
