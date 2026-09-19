process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??=
  "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";

// Deliberately NOT setting SINGLE_OPERATOR_MODE — proving the default (off)
// reproduces upstream's original self-service behavior: /login renders
// ungated and /login/qr passes the caller-supplied userId query param
// straight through, never forcing config.ownerUserId.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { createLoginRoutes } = await import("../routes/login.js");

type LoginRoutesDeps = Parameters<typeof createLoginRoutes>[0];

/** Records every userId `getOrCreateSession` is called with, then rejects —
 *  there's no real Telegram client in this test, and handleQrLogin's own
 *  try/catch turns that rejection into an SSE `error_msg` event, so the route
 *  handler itself never throws. We only care WHICH userId it was called
 *  with, never whether the (fake) login succeeds. Same technique as
 *  login-route-admin-gate.test.ts's makeSessionsStub. */
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

describe("GET /login multi-tenant (SINGLE_OPERATOR_MODE unset)", () => {
  it("renders the login page with no cookie at all — no admin gate, no redirect", async () => {
    const { sessions } = makeSessionsStub();
    const res = await makeApp(sessions).request("/login", { redirect: "manual" });
    assert.equal(res.status, 200);
  });
});

describe("GET /login/qr multi-tenant — restores upstream's self-service flow", () => {
  it("400s 'userId required' when the userId query param is missing", async () => {
    const { sessions, calls } = makeSessionsStub();
    const res = await makeApp(sessions).request("/login/qr");
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "userId required");
    assert.deepEqual(calls, []);
  });

  it("uses the caller-supplied userId query param, with no admin session required", async () => {
    const { sessions, calls } = makeSessionsStub();
    const res = await makeApp(sessions).request("/login/qr?userId=someone");
    assert.equal(res.status, 200); // SSE stream opened
    await res.text(); // drain the stream so handleQrLogin's synchronous start() work has definitely run
    assert.deepEqual(calls, ["someone"]);
  });
});
