import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

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

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
    };
  }

  /** Validate Bearer token, return userId or null */
  validateToken(token: string): string | null {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE access_token = ?").get(token) as
      | AccessToken
      | undefined;

    if (!row) return null;
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      this.db.prepare("DELETE FROM oauth_tokens WHERE access_token = ?").run(token);
      return null;
    }

    return row.user_id;
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

/** HTML page for /oauth/authorize — simple user approval form */
export function renderAuthorizePage(params: {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP Telegram — Authorize</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 16px; padding: 40px;
      max-width: 420px; width: 100%; box-shadow: 0 25px 50px rgba(0,0,0,.3); }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; }
    .client { background: #334155; border-radius: 8px; padding: 12px 16px;
      margin-bottom: 24px; font-size: 14px; }
    label { display: block; font-size: 14px; margin-bottom: 6px; color: #cbd5e1; }
    input { width: 100%; padding: 10px 14px; border: 1px solid #475569;
      border-radius: 8px; background: #0f172a; color: #e2e8f0; font-size: 16px;
      margin-bottom: 16px; outline: none; }
    input:focus { border-color: #3b82f6; }
    button { width: 100%; padding: 12px; border: none; border-radius: 8px;
      background: #3b82f6; color: white; font-size: 16px; font-weight: 600;
      cursor: pointer; transition: background .2s; }
    button:hover { background: #2563eb; }
    .error { background: #7f1d1d; border-radius: 8px; padding: 12px; margin-bottom: 16px;
      font-size: 14px; }
    .scope { color: #94a3b8; font-size: 13px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Authorize</h1>
    <p class="subtitle">MCP Telegram Cloud</p>
    ${params.error ? `<div class="error">${params.error}</div>` : ""}
    <div class="client">
      <strong>${params.clientName || "MCP Client"}</strong> wants to access your Telegram (read-only).
    </div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${params.clientId}">
      <input type="hidden" name="redirect_uri" value="${params.redirectUri}">
      <input type="hidden" name="state" value="${params.state}">
      <input type="hidden" name="code_challenge" value="${params.codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${params.codeChallengeMethod}">
      <label for="username">Your username</label>
      <input type="text" id="username" name="username" placeholder="e.g. overpod" required autofocus>
      <button type="submit">Authorize</button>
    </form>
    <p class="scope">Scope: read-only access to chats, messages, contacts</p>
  </div>
</body>
</html>`;
}
