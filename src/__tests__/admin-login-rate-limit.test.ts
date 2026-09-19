// Finding 1 (final-branch review, 2026-09-18-single-operator-auth): /admin-login
// had no rate limiting in front of blocking-scrypt password verification —
// both a brute-force and a DoS vector (enough concurrent attempts stall Bun's
// single event loop). This proves adminLoginRateLimit is actually wired onto
// the route for both GET and POST.
//
// Small, file-local limit so the test doesn't need 11 requests to trip it.
// Env-before-import: config.ts and rate-limit.ts resolve these at load time.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??=
  "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";
process.env.ADMIN_LOGIN_RATE_LIMIT = "3";
process.env.ADMIN_LOGIN_RATE_WINDOW_MS = "60000";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { createAdminLoginRoutes } = await import("../routes/admin-login.js");

function makeApp() {
  return createAdminLoginRoutes();
}

// Distinct simulated IPs (via X-Real-IP) per test so each gets its own bucket
// and the tests don't interfere with each other's counts.
function postLogin(app: ReturnType<typeof makeApp>, ip: string) {
  return app.request("/?returnTo=%2Fmy", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-real-ip": ip },
    body: "username=alice&password=wrong-on-purpose",
    redirect: "manual",
  });
}

function getLogin(app: ReturnType<typeof makeApp>, ip: string) {
  return app.request("/", { headers: { "x-real-ip": ip } });
}

describe("adminLoginRateLimit on /admin-login", () => {
  it("rate-limits repeated POST attempts past the configured cap (429, Retry-After)", async () => {
    const app = makeApp();
    const ip = "203.0.113.10";

    // Limit is 3/min: first 3 attempts go through to the normal login logic
    // (redirect, since the password is wrong), the 4th is rate-limited.
    for (let i = 0; i < 3; i++) {
      const res = await postLogin(app, ip);
      assert.equal(res.status, 302);
    }
    const blocked = await postLogin(app, ip);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"));
    const body = (await blocked.json()) as { error: string; retryAfter: number };
    assert.equal(body.error, "rate_limit_exceeded");
    assert.ok(body.retryAfter > 0);
  });

  it("counts GET requests against the same bucket as POST (both covered)", async () => {
    const app = makeApp();
    const ip = "203.0.113.20";

    // Mix GET and POST — the limiter is mounted on /* with one shared scope,
    // so GET traffic burns the same budget as POST.
    assert.equal((await getLogin(app, ip)).status, 200);
    assert.equal((await postLogin(app, ip)).status, 302);
    assert.equal((await getLogin(app, ip)).status, 200);
    // 4th request on this IP within the window exceeds the limit of 3.
    const blocked = await getLogin(app, ip);
    assert.equal(blocked.status, 429);
  });

  it("does not rate-limit a fresh IP", async () => {
    const app = makeApp();
    const res = await getLogin(app, "203.0.113.30");
    assert.equal(res.status, 200);
  });
});
