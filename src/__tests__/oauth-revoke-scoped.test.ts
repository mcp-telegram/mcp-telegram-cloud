process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder"; // this test never reads config.adminPasswordHash
process.env.SINGLE_OPERATOR_MODE ??= "true";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { createOAuthRoutes } = await import("../routes/oauth.js");

// Single-operator mode (flag on): multiple OAuth clients share one fixed
// owner id, so /oauth/revoke must scope to exactly the presented token —
// no cascade to other clients' tokens, AND no Telegram-session teardown
// (that's reserved for the admin panel's explicit "Disconnect Telegram"
// action — see final-branch-review finding 1 and routes/admin.tsx). The
// off-mode (multi-tenant) counterpart lives in
// oauth-revoke-multi-tenant.test.ts and asserts the opposite for the
// Telegram-logout call.
describe("POST /oauth/revoke (single-operator mode)", () => {
  it("revokes only the presented token — never touches other clients' tokens or the shared Telegram session", async () => {
    let destroyUserSessionCalls = 0;
    let revokeAllUserTokensCalls = 0;

    const oauthStub = {
      revokeToken: (token: string) => (token === "target-token" ? "admin:alice" : null),
      revokeAllUserTokens: (_userId: string) => {
        revokeAllUserTokensCalls++;
        return 0;
      },
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];

    const sessionsStub = {
      destroyUserSession: async (_userId: string) => {
        destroyUserSessionCalls++;
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
    assert.equal(destroyUserSessionCalls, 0, "single-operator revoke must NOT log out the shared Telegram session");
    assert.equal(revokeAllUserTokensCalls, 0, "revoke must NOT wipe every other client's tokens");
  });

  it("still returns 200 per RFC 7009 for an unknown/already-expired token", async () => {
    const oauthStub = {
      revokeToken: () => null,
      revokeAllUserTokens: () => 0,
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];
    const sessionsStub = {} as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];

    const app = new Hono();
    app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions: sessionsStub }));

    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=unknown-token",
    });
    assert.equal(res.status, 200);
  });
});
