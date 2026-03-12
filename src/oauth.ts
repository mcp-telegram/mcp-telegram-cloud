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
    console.log(`[oauth] Revoked token for user ${row.user_id}`);
    return row.user_id;
  }

  /**
   * Revoke ALL tokens for a given user_id.
   */
  revokeAllUserTokens(userId: string): number {
    const result = this.db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(userId);
    console.log(`[oauth] Revoked all tokens for user ${userId}: ${result.changes} removed`);
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

/** HTML page for /oauth/authorize — QR-based Telegram login + OAuth authorization */
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
      max-width: 420px; width: 100%; box-shadow: 0 25px 50px rgba(0,0,0,.3);
      text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; }
    .client { background: #334155; border-radius: 8px; padding: 12px 16px;
      margin-bottom: 24px; font-size: 14px; }
    .qr-container { background: white; border-radius: 12px; padding: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      margin: 20px 0; min-height: 288px; min-width: 288px; }
    .qr-container img { width: 256px; height: 256px; }
    .status { color: #94a3b8; font-size: 14px; margin: 16px 0; min-height: 20px; }
    .success { background: #065f46; border-radius: 12px; padding: 20px; margin: 20px 0; }
    .success h2 { color: #34d399; font-size: 20px; margin-bottom: 8px; }
    .error { background: #7f1d1d; border-radius: 8px; padding: 12px; margin-bottom: 16px;
      font-size: 14px; }
    .step { background: #334155; border-radius: 8px; padding: 12px; margin: 8px 0;
      font-size: 13px; text-align: left; }
    .step strong { color: #60a5fa; }
    .scope { color: #94a3b8; font-size: 13px; margin-top: 16px; }
    .spinner { display: inline-block; width: 24px; height: 24px;
      border: 3px solid #475569; border-top-color: #3b82f6;
      border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #qr-section, #result { display: none; }
    #qr-section.active, #result.active { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <h1>MCP Telegram</h1>
    <p class="subtitle">Connect your Telegram account</p>
    ${params.error ? `<div class="error">${params.error}</div>` : ""}
    <div class="client">
      <strong>${params.clientName || "MCP Client"}</strong> wants read-only access to your Telegram.
    </div>

    <div id="qr-section" class="active">
      <div class="qr-container" id="qr-container">
        <div class="spinner"></div>
      </div>
      <div class="status" id="status">Connecting...</div>
      <div class="step"><strong>Step 1:</strong> Open Telegram on your phone</div>
      <div class="step"><strong>Step 2:</strong> Go to Settings → Devices → Link Desktop Device</div>
      <div class="step"><strong>Step 3:</strong> Scan the QR code above</div>
    </div>

    <div id="result"></div>

    <p class="scope">Scope: read-only access to chats, messages, contacts</p>
  </div>

  <script>
    (function() {
      var qs = new URLSearchParams({
        client_id: ${JSON.stringify(params.clientId)},
        redirect_uri: ${JSON.stringify(params.redirectUri)},
        state: ${JSON.stringify(params.state)},
        code_challenge: ${JSON.stringify(params.codeChallenge)},
        code_challenge_method: ${JSON.stringify(params.codeChallengeMethod)}
      });

      var es = new EventSource('/oauth/authorize/qr?' + qs.toString());

      es.addEventListener('qr', function(e) {
        var data = JSON.parse(e.data);
        document.getElementById('qr-container').innerHTML =
          '<img src="' + data.dataUrl + '" alt="QR Code">';
      });

      es.addEventListener('status', function(e) {
        var data = JSON.parse(e.data);
        document.getElementById('status').textContent = data.message;
      });

      es.addEventListener('redirect', function(e) {
        var data = JSON.parse(e.data);
        es.close();
        document.getElementById('qr-section').classList.remove('active');
        document.getElementById('result').classList.add('active');
        document.getElementById('result').innerHTML =
          '<div class="success">' +
          '<h2>Connected!</h2>' +
          '<p>' + (data.name || '') + ' (@' + (data.username || 'unknown') + ')</p>' +
          '<p style="margin-top:12px;font-size:13px;color:#94a3b8">Redirecting...</p>' +
          '</div>';
        setTimeout(function() { window.location.href = data.url; }, 1000);
      });

      es.addEventListener('error_msg', function(e) {
        var data = JSON.parse(e.data);
        es.close();
        document.getElementById('qr-section').classList.remove('active');
        document.getElementById('result').classList.add('active');
        document.getElementById('result').innerHTML =
          '<div class="error"><p>' + data.message + '</p></div>';
      });

      es.onerror = function() {
        document.getElementById('status').textContent = 'Connection lost. Refresh to retry.';
      };
    })();
  </script>
</body>
</html>`;
}
