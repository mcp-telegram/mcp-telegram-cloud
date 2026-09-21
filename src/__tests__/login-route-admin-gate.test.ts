process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.SINGLE_OPERATOR_MODE ??= "true";
// Same fixed literal as the other admin-gate test files in this task (Task 3's
// convention) — must be set BEFORE any import. Importing `../auth/admin.js`
// (which transitively imports `config.js`) first would freeze
// `config.adminPasswordHash` at "" for the rest of this process.
process.env.ADMIN_PASSWORD_HASH ??=
  "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { buildAdminSessionCookie } = await import("../auth/admin.js");
const { config } = await import("../config.js");
const { createLoginRoutes } = await import("../routes/login.js");

type LoginRoutesDeps = Parameters<typeof createLoginRoutes>[0];

/** Records every userId `getOrCreateSession` is called with, then rejects —
 *  there's no real Telegram client in this test, and handleQrLogin's own
 *  try/catch turns that rejection into an SSE `error_msg` event, so the route
 *  handler itself never throws. We only care WHICH userId it was called
 *  with, never whether the (fake) login succeeds. */
function makeSessionsStub() {
  const calls: string[] = [];
  const sessions = {
    getOrCreateSession: async (userId: string) => {
      calls.push(userId);
      throw new Error("stub: no real Telegram client in this test");
    },
  } as unknown as LoginRoutesDeps["sessions"];
  return { sessions, calls };
}

function makeApp(sessions: LoginRoutesDeps["sessions"]) {
  const app = new Hono();
  app.route("/login", createLoginRoutes({ sessions }));
  return app;
}

describe("GET /login admin gate", () => {
  it("renders the login page for a valid admin session (does not redirect)", async () => {
    const { sessions } = makeSessionsStub();
    const cookie = buildAdminSessionCookie().split(";")[0];
    const res = await makeApp(sessions).request("/login", { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 200);
  });

  it("redirects to /admin-login with no cookie", async () => {
    const { sessions } = makeSessionsStub();
    const res = await makeApp(sessions).request("/login", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^\/admin-login/);
  });
});

describe("GET /login/qr admin gate — closes the userId-hijack path", () => {
  it("403s with no admin session, and never touches session storage for the attacker-chosen userId", async () => {
    const { sessions, calls } = makeSessionsStub();
    const res = await makeApp(sessions).request("/login/qr?userId=someone-else");
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []); // getOrCreateSession must never be reached without a valid admin session
  });

  it("with a valid admin session, still uses the fixed config.ownerUserId — never the userId query param", async () => {
    const { sessions, calls } = makeSessionsStub();
    const cookie = buildAdminSessionCookie().split(";")[0];
    const res = await makeApp(sessions).request("/login/qr?userId=someone-else", { headers: { cookie } });
    assert.equal(res.status, 200); // SSE stream opened
    await res.text(); // drain the stream so handleQrLogin's synchronous start() work has definitely run
    assert.deepEqual(calls, [config.ownerUserId]);
    assert.ok(!calls.includes("someone-else"));
  });
});
