process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder"; // this test never reads config.adminPasswordHash

// Deliberately NOT setting SINGLE_OPERATOR_MODE — proving the default (off,
// multi-tenant) behavior.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { createOAuthRoutes } = await import("../routes/oauth.js");

/**
 * Final-branch-review finding 1: in multi-tenant mode (flag off), one
 * Telegram identity IS one user — `/oauth/revoke` is that user's ONLY
 * self-service disconnect (`/my/*` has no disconnect route, and
 * `/api/disconnect-telegram` is admin-only and hardwired to
 * `config.ownerUserId`). A previous task removed the Telegram-logout
 * cascade entirely, reasoning it was a bug in all modes — that was only
 * true for the "cascade to every OTHER OAuth client's tokens" part
 * (`revokeAllUserTokens`, still asserted NOT called below). Dropping the
 * Telegram logout too left a live Telegram session + encrypted session
 * string on the server forever after a multi-tenant user "revokes".
 *
 * This restores `destroyUserSession` for exactly the revoked user, in
 * off-mode only. The on-mode counterpart (oauth-revoke-scoped.test.ts)
 * asserts the opposite: single-operator mode shares one owner id across
 * multiple OAuth clients, so a full teardown here would log out every
 * other client too — that mode uses the admin panel's explicit
 * "Disconnect Telegram" action instead.
 */
describe("POST /oauth/revoke (multi-tenant mode, default)", () => {
  it("revokes the presented token AND destroys that user's Telegram session — but never cascades to other clients' tokens", async () => {
    let destroyUserSessionCalls = 0;
    let destroyUserSessionUserId: string | undefined;
    let revokeAllUserTokensCalls = 0;

    const oauthStub = {
      revokeToken: (token: string) => (token === "target-token" ? "some_tg_handle" : null),
      revokeAllUserTokens: (_userId: string) => {
        revokeAllUserTokensCalls++;
        return 0;
      },
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];

    const sessionsStub = {
      destroyUserSession: async (userId: string) => {
        destroyUserSessionCalls++;
        destroyUserSessionUserId = userId;
        return { loggedOut: true };
      },
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];

    const app = new Hono();
    app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions: sessionsStub }));

    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=target-token",
    });

    assert.equal(res.status, 200);
    assert.equal(destroyUserSessionCalls, 1, "multi-tenant revoke must log out the revoked user's Telegram session");
    assert.equal(destroyUserSessionUserId, "some_tg_handle");
    assert.equal(revokeAllUserTokensCalls, 0, "revoke must still NOT wipe every other client's tokens");
  });

  it("does not call destroyUserSession for an unknown/already-expired token, and still returns 200", async () => {
    let destroyUserSessionCalls = 0;
    const oauthStub = {
      revokeToken: () => null,
      revokeAllUserTokens: () => 0,
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];
    const sessionsStub = {
      destroyUserSession: async () => {
        destroyUserSessionCalls++;
        return { loggedOut: false };
      },
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];

    const app = new Hono();
    app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions: sessionsStub }));

    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=unknown-token",
    });
    assert.equal(res.status, 200);
    assert.equal(destroyUserSessionCalls, 0);
  });
});
