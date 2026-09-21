process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.SINGLE_OPERATOR_MODE ??= "true";
// Same fixed literal as oauth-authorize-admin-gate.test.ts (Task 3's convention) —
// must be set BEFORE any import. Importing `../auth/admin.js` (which transitively
// imports `config.js`) first would freeze `config.adminPasswordHash` at "" for the
// rest of this process, which would make the forged-cookie test below meaningless
// (a zero-length HMAC key is trivially reproducible).
process.env.ADMIN_PASSWORD_HASH ??=
  "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { buildAdminSessionCookie } = await import("../auth/admin.js");
const { createMyRoutes } = await import("../routes/my.js");

type MyRoutesDeps = Parameters<typeof createMyRoutes>[0];

// Minimal stubs: GET /my/settings only touches `destructive.isEnabled` and
// `destructive.todayOkCount`. `sessions`/`uploads` are never called on that
// path — this test is about the requireUser() admin gate, not the settings
// page's data, so they stay empty stubs rather than full fakes.
const destructiveStub = {
  isEnabled: (_userId: string) => false,
  todayOkCount: (_userId: string) => 0,
} as unknown as MyRoutesDeps["destructive"];
const sessionsStub = {} as unknown as MyRoutesDeps["sessions"];
const uploadsStub = {} as unknown as MyRoutesDeps["uploads"];

function makeApp() {
  const app = new Hono();
  app.route("/my", createMyRoutes({ destructive: destructiveStub, sessions: sessionsStub, uploads: uploadsStub }));
  return app;
}

/** Right shape (`<expiry>.<hex sig>`), wrong signature — same forging technique
 *  as oauth-authorize-admin-gate.test.ts's buildForgedAdminCookie. */
function buildForgedAdminCookie(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const payload = String(expiresAt);
  const wrongSig = "0".repeat(64); // sha256 hex digest length — matches a real sig's length
  return `admin_session=${payload}.${wrongSig}`;
}

describe("GET /my/settings admin gate", () => {
  it("renders settings for a valid admin session (does not redirect to /admin-login)", async () => {
    const cookie = buildAdminSessionCookie().split(";")[0];
    const res = await makeApp().request("/my/settings", { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 200);
  });

  it("redirects to /admin-login with no cookie at all", async () => {
    const res = await makeApp().request("/my/settings", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^\/admin-login/);
  });

  it("redirects to /admin-login for a forged tg_user cookie with no admin_session — the old bypass is closed", async () => {
    // Pins Finding 1: /oauth/authorize now saves sessions under the fixed,
    // predictable config.ownerUserId ("admin:alice"), so a `tg_user` cookie set
    // to that exact value used to be enough to pass the old requireUser() check
    // (which cross-referenced saved session ids, not a signed credential). This
    // proves my.tsx no longer consults tg_user at all.
    const res = await makeApp().request("/my/settings", {
      headers: { cookie: "tg_user=admin%3Aalice" },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^\/admin-login/);
  });

  it("redirects to /admin-login for a forged admin_session cookie (right shape, wrong signature)", async () => {
    const res = await makeApp().request("/my/settings", {
      headers: { cookie: buildForgedAdminCookie() },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^\/admin-login/);
  });
});
