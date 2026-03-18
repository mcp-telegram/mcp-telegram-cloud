import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { logger } from "./logger.js";

/** OAuth 2.0 Authorization Server for MCP (RFC 8414, RFC 7591, RFC 7636) */

export interface OAuthConfig {
  issuer: string; // e.g. "https://mcp-telegram.com"
  db: Database.Database;
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
  private db: Database.Database;
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
    `);
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
      grant_types_supported: ["authorization_code"],
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
      clientName: body.client_name ?? "",
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
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min

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

  /** Exchange authorization code for access token */
  exchangeCode(params: {
    code: string;
    clientId: string;
    codeVerifier: string;
    redirectUri: string;
  }): { access_token: string; token_type: string; expires_in: number } | null {
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

    // Issue access token
    const accessToken = randomBytes(32).toString("hex");
    const expiresIn = 86400 * 30; // 30 days

    this.db
      .prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(accessToken, row.client_id, row.user_id, Math.floor(Date.now() / 1000) + expiresIn);

    logger.info(`OAuth token issued for ${row.user_id}`, {
      component: "oauth",
      event: "oauth.token.issued",
      userId: row.user_id,
      clientId: row.client_id,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
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
    logger.info(`OAuth token revoked for ${row.user_id}`, {
      component: "oauth",
      event: "oauth.token.revoke",
      userId: row.user_id,
    });
    return row.user_id;
  }

  /**
   * Revoke ALL tokens for a given user_id.
   */
  revokeAllUserTokens(userId: string): number {
    const result = this.db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(userId);
    logger.info(`All tokens revoked for ${userId}: ${result.changes} removed`, {
      component: "oauth",
      event: "oauth.token.revoke_all",
      userId,
      count: result.changes,
    });
    return result.changes;
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

  /** Cleanup expired codes and tokens */
  cleanup(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
  }
}
