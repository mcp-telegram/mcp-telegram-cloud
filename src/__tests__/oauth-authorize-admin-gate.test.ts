process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.SINGLE_OPERATOR_MODE ??= "true";
process.env.ADMIN_USERNAME ??= "alice";
// Fixed literal (Task 3's convention) — must be set BEFORE any import. Importing
// `../auth/admin.js` (which transitively imports `config.js`) before this line
// would freeze `config.adminPasswordHash` at "" for the rest of this process,
// since `config` is a module-level singleton computed once. An empty signing
// key is a real bug for the forged/expired-cookie tests below: they need a
// non-empty HMAC key an attacker can't trivially reproduce.
process.env.ADMIN_PASSWORD_HASH ??=
  "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { buildAdminSessionCookie } = await import("../auth/admin.js");
const { config } = await import("../config.js");
const { createOAuthRoutes } = await import("../routes/oauth.js");

const oauthStub = {
  getClient: (id: string) =>
    id === "known"
      ? { client_id: "known", client_name: "Test", redirect_uris: JSON.stringify(["https://client.example/cb"]) }
      : undefined,
  clientCount: () => 0,
  createAuthCode: (_args: unknown) => "test-code",
} as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];

function makeApp(tryReconnectSession: (userId: string) => Promise<unknown>) {
  const sessions = { tryReconnectSession } as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];
  const app = new Hono();
  app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions }));
  return app;
}

const AUTHORIZE_QS =
  "client_id=known&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=xyz&code_challenge=abc&code_challenge_method=S256";

/** Right shape (`<expiry>.<hex sig>`), wrong signature — same length as a real
 *  one so it clears the constant-time length check and actually exercises the
 *  HMAC comparison, not just a shape check. */
function buildForgedAdminCookie(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const payload = String(expiresAt);
  const wrongSig = "0".repeat(64); // sha256 hex digest is 64 chars — matches a real sig's length
  return `admin_session=${payload}.${wrongSig}`;
}

/** Validly signed under the real key, but the embedded expiry is in the past —
 *  proves expiry is actually enforced, not just the signature. */
function buildExpiredAdminCookie(): string {
  const expiresAt = Math.floor(Date.now() / 1000) - 60;
  const payload = String(expiresAt);
  const sig = createHmac("sha256", Buffer.from(config.adminPasswordHash)).update(payload).digest("hex");
  return `admin_session=${payload}.${sig}`;
}

describe("GET /oauth/authorize admin gate", () => {
  it("redirects to /admin-login when there is no admin session — never issues a code", async () => {
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^\/admin-login\?returnTo=/);
  });

  it("issues a code via fast redirect when the admin session is valid and a primary Telegram session already exists", async () => {
    const cookie = buildAdminSessionCookie().split(";")[0];
    const app = makeApp(async (userId) => {
      assert.equal(userId, "admin:alice"); // must use the FIXED owner id, not a per-visitor hint
      return { fake: "telegram-service" };
    });
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    const location = res.headers.get("location") ?? "";
    assert.match(location, /^https:\/\/client\.example\/cb\?code=test-code&state=xyz$/);
  });

  it("falls through to the QR bootstrap page when admin session is valid but no Telegram session exists yet", async () => {
    const cookie = buildAdminSessionCookie().split(";")[0];
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /qr|QR/); // renders the existing AuthorizePage/QR flow, unchanged
  });
});

describe("GET /oauth/authorize/qr admin gate", () => {
  it("403s without a valid admin session (defense in depth if hit directly)", async () => {
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize/qr?${AUTHORIZE_QS}`);
    assert.equal(res.status, 403);
  });
});

describe("admin gate rejects non-admin credentials — no bypass via a spoofed or stale cookie", () => {
  const cases: Array<{ name: string; cookie: string }> = [
    { name: "forged admin_session cookie (right shape, wrong signature)", cookie: buildForgedAdminCookie() },
    { name: "expired admin_session cookie (valid signature, past expiry)", cookie: buildExpiredAdminCookie() },
    {
      name: "tg_user-only cookie, no admin_session at all (the old identity-hint mechanism cannot substitute for the admin gate)",
      cookie: "tg_user=admin%3Aalice",
    },
  ];

  for (const { name, cookie } of cases) {
    it(`GET /authorize — ${name} → 302 to /admin-login, never issues a code`, async () => {
      const app = makeApp(async () => {
        throw new Error("must not attempt session reconnect without a valid admin session");
      });
      const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, {
        headers: { cookie },
        redirect: "manual",
      });
      assert.equal(res.status, 302);
      assert.match(res.headers.get("location") ?? "", /^\/admin-login\?returnTo=/);
    });

    it(`GET /authorize/qr — ${name} → 403`, async () => {
      const app = makeApp(async () => {
        throw new Error("must not attempt session reconnect without a valid admin session");
      });
      const res = await app.request(`/oauth/authorize/qr?${AUTHORIZE_QS}`, { headers: { cookie } });
      assert.equal(res.status, 403);
    });
  }
});
