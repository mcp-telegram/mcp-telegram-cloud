/**
 * Admin user-lifecycle API (v2.42.0): GET /api/users, GET /api/integrity,
 * DELETE /api/users/:id.
 *
 * Covers the contract the dead-user audit relies on:
 *   - /users enriches every user_sessions row with usage activity + token state
 *   - /integrity flags plaintext leftovers, expired-token garbage and orphan rows
 *   - DELETE mirrors the OAuth-revoke path: logOut + purge + revokeAllUserTokens
 *   - all three are ADMIN_TOKEN-gated
 *
 * Env-before-import pattern (see session-manager-encryption.test.ts): config and
 * crypto resolve env at module load, so set everything before the first import.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.ADMIN_TOKEN = "admin-users-api-test-token";
process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { OAuthProvider } = await import("../oauth.js");
const { UsageTracker } = await import("../usage.js");
const { createAdminRoutes } = await import("../routes/admin.js");
const { listUsers, checkIntegrity } = await import("../admin-inspect.js");
const { hashToken } = await import("../crypto.js");

class StubTelegramService {
  private connected = false;
  private sessionString: string | undefined;
  loggedOut = false;
  async connect(): Promise<boolean> {
    this.connected = true;
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async ensureConnected(): Promise<boolean> {
    this.connected = true;
    return true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async logOut(): Promise<boolean> {
    this.loggedOut = true;
    return true;
  }
  setSessionString(s: string): void {
    this.sessionString = s;
  }
  getSessionString(): string | undefined {
    return this.sessionString;
  }
}

const ADMIN_HEADER = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

function makeFixture() {
  const sessions = new SessionManager(":memory:", () => new StubTelegramService() as unknown as TelegramService);
  const db = sessions.getDb();
  const oauth = new OAuthProvider({ issuer: "https://test.example.com", db });
  const usage = new UsageTracker(db);
  const app = createAdminRoutes({ oauth, sessions, usage });
  return { sessions, db, oauth, usage, app };
}

const FUTURE_SEC = Math.floor(Date.now() / 1000) + 3600;
const PAST_SEC = Math.floor(Date.now() / 1000) - 3600;

describe("listUsers", () => {
  it("enriches users with usage, token and account state", () => {
    const { sessions, db, usage } = makeFixture();
    sessions.saveSessionString("alex", "session-a");
    sessions.saveSessionString("ghost", "session-g");
    sessions.addAccount("alex", "lizzy-tg-id", "session-l", "Lizzy");
    usage.logToolCall("alex", "telegram-list-chats", "Claude");
    usage.logToolCall("alex", "telegram-get-unread", "Claude");
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      hashToken("at-1"),
      "client-1",
      "alex",
      FUTURE_SEC,
    );
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hashToken("rt-1"), "client-1", "alex", 0); // eternal scheme

    const users = listUsers(db);
    assert.equal(users.length, 2);

    const alex = users.find((u) => u.userId === "alex");
    assert.ok(alex);
    assert.equal(alex.sessionEncrypted, true);
    assert.equal(alex.secondaryAccounts, 1);
    assert.equal(alex.activeAccessTokens, 1);
    assert.equal(alex.activeRefreshTokens, 1);
    assert.equal(alex.totalCalls, 2);
    assert.deepEqual(alex.clients, ["Claude"]);
    assert.equal(alex.inactiveDays, 0);

    const ghost = users.find((u) => u.userId === "ghost");
    assert.ok(ghost);
    assert.equal(ghost.totalCalls, 0);
    assert.equal(ghost.lastSeen, null);
    assert.equal(ghost.inactiveDays, null, "never-active user has no inactiveDays — judge by createdAt");
  });

  it("does not count expired or revoked tokens as active", () => {
    const { sessions, db } = makeFixture();
    sessions.saveSessionString("alex", "session-a");
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      hashToken("at-expired"),
      "client-1",
      "alex",
      PAST_SEC,
    );
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, revoked) VALUES (?, ?, ?, ?, 1)",
    ).run(hashToken("rt-revoked"), "client-1", "alex", 0);

    const [alex] = listUsers(db);
    assert.equal(alex.activeAccessTokens, 0);
    assert.equal(alex.activeRefreshTokens, 0);
  });
});

describe("checkIntegrity", () => {
  it("reports a clean db as clean", () => {
    const { sessions, db, usage } = makeFixture();
    sessions.saveSessionString("alex", "session-a");
    usage.logToolCall("alex", "telegram-status", "Claude");

    const report = checkIntegrity(db);
    assert.deepEqual(report.plaintextSessions, []);
    assert.deepEqual(report.plaintextSecondarySessions, []);
    assert.equal(report.plaintextAccessTokens, 0);
    assert.equal(report.plaintextRefreshTokens, 0);
    assert.deepEqual(report.orphanSecondaryAccounts, []);
    assert.deepEqual(report.usageUsersWithoutSession, []);
    assert.equal(report.tableCounts.user_sessions, 1);
    assert.equal(report.tableCounts.usage_log, 1);
  });

  it("flags plaintext leftovers, expired garbage and orphan rows", () => {
    const { sessions, db, usage } = makeFixture();
    sessions.saveSessionString("alex", "session-a");
    // Legacy plaintext rows written behind the encryption helpers' back.
    db.prepare("INSERT INTO user_sessions (user_id, session_string) VALUES ('legacy', 'PLAINTEXT==')").run();
    db.prepare(
      "INSERT INTO telegram_accounts (owner_user_id, telegram_user_id, session_string) VALUES ('gone-owner', 'tg-9', 'PLAINTEXT2==')",
    ).run();
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      "raw-plaintext-token",
      "client-1",
      "tokens-only-user",
      PAST_SEC,
    );
    db.prepare("INSERT INTO active_account (owner_user_id, account_id) VALUES ('gone-owner', 1)").run();
    usage.logToolCall("disconnected-user", "telegram-status", "ChatGPT");

    const report = checkIntegrity(db);
    assert.deepEqual(report.plaintextSessions, ["legacy"]);
    assert.equal(report.plaintextSecondarySessions.length, 1);
    assert.equal(report.plaintextAccessTokens, 1);
    assert.equal(report.expiredAccessTokens, 1);
    assert.deepEqual(
      report.orphanSecondaryAccounts.map((o) => o.ownerUserId),
      ["gone-owner"],
    );
    assert.deepEqual(report.orphanActiveAccountRows, ["gone-owner"]);
    assert.deepEqual(report.usageUsersWithoutSession, ["disconnected-user"]);
    // Expired token user must NOT appear in tokenUsersWithoutSession (only live tokens matter).
    assert.deepEqual(report.tokenUsersWithoutSession, []);
  });
});

describe("admin routes auth + wiring", () => {
  it("rejects /users, /integrity and DELETE without admin token", async () => {
    const { app } = makeFixture();
    for (const [path, method] of [
      ["/users", "GET"],
      ["/integrity", "GET"],
      ["/users/alex", "DELETE"],
    ] as const) {
      const res = await app.request(path, { method });
      assert.equal(res.status, 401, `${method} ${path} must be admin-gated`);
    }
  });

  it("GET /users returns enriched list", async () => {
    const { app, sessions, usage } = makeFixture();
    sessions.saveSessionString("alex", "session-a");
    usage.logToolCall("alex", "telegram-status", "Claude");

    const res = await app.request("/users", { headers: ADMIN_HEADER });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: number; users: { userId: string; totalCalls: number }[] };
    assert.equal(body.total, 1);
    assert.equal(body.users[0].userId, "alex");
    assert.equal(body.users[0].totalCalls, 1);
  });

  it("DELETE /users/:id destroys session and revokes tokens; 404 for unknown", async () => {
    const { app, sessions, db } = makeFixture();
    sessions.saveSessionString("dead-user", "session-d");
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      hashToken("at-dead"),
      "client-1",
      "dead-user",
      FUTURE_SEC,
    );
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hashToken("rt-dead"), "client-1", "dead-user", 0);

    const res = await app.request("/users/dead-user", { method: "DELETE", headers: ADMIN_HEADER });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; loggedOut: boolean; revokedTokens: number };
    assert.equal(body.ok, true);
    assert.equal(
      body.loggedOut,
      true,
      "non-pooled (dead) user must be warmed up so Telegram logOut actually revokes the auth key",
    );
    assert.equal(body.revokedTokens, 2);

    assert.equal(db.prepare("SELECT 1 FROM user_sessions WHERE user_id = 'dead-user'").get(), null);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get() as { n: number }).n, 0, "no tokens left");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM oauth_refresh_tokens").get() as { n: number }).n,
      0,
      "no refresh tokens left",
    );

    const second = await app.request("/users/dead-user", { method: "DELETE", headers: ADMIN_HEADER });
    assert.equal(second.status, 404, "second delete finds nothing");
  });
});
