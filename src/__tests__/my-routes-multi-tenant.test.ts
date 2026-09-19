process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??=
  "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";

// Deliberately NOT setting SINGLE_OPERATOR_MODE — proving the default (off)
// reproduces upstream's original multi-tenant behavior: /my/* is gated by the
// tg_user cookie cross-checked against saved session ids, not the admin
// session cookie.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { buildAdminSessionCookie } = await import("../auth/admin.js");
const { createMyRoutes } = await import("../routes/my.js");

type MyRoutesDeps = Parameters<typeof createMyRoutes>[0];

// Minimal stubs: GET /my/settings only touches `destructive.isEnabled` and
// `destructive.todayOkCount` plus (in multi-tenant mode) `sessions.getSavedUserIds`.
// Mirrors my-routes-admin-gate.test.ts's stub shape, swapping the auth mechanism.
const destructiveStub = {
  isEnabled: (_userId: string) => false,
  todayOkCount: (_userId: string) => 0,
} as unknown as MyRoutesDeps["destructive"];
const uploadsStub = {} as unknown as MyRoutesDeps["uploads"];

function makeApp(savedUserIds: string[]) {
  const sessions = { getSavedUserIds: () => savedUserIds } as unknown as MyRoutesDeps["sessions"];
  const app = new Hono();
  app.route("/my", createMyRoutes({ destructive: destructiveStub, sessions, uploads: uploadsStub }));
  return app;
}

describe("GET /my/settings — multi-tenant (SINGLE_OPERATOR_MODE unset)", () => {
  it("renders settings for a tg_user cookie matching a saved session id", async () => {
    const app = makeApp(["alice_tg"]);
    const res = await app.request("/my/settings", {
      headers: { cookie: "tg_user=alice_tg" },
      redirect: "manual",
    });
    assert.equal(res.status, 200);
  });

  it("redirects to the issuer login page for a tg_user cookie NOT matching any saved session id", async () => {
    const app = makeApp(["alice_tg"]);
    const res = await app.request("/my/settings", {
      headers: { cookie: "tg_user=mallory_tg" },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://example.com/login");
  });

  it("redirects to the issuer login page with no cookie at all", async () => {
    const app = makeApp(["alice_tg"]);
    const res = await app.request("/my/settings", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://example.com/login");
  });

  it("redirects to the issuer login page for a valid admin_session cookie with no tg_user cookie — the admin-session mechanism has no effect at all in default mode", async () => {
    const app = makeApp(["alice_tg"]);
    const cookie = buildAdminSessionCookie().split(";")[0];
    const res = await app.request("/my/settings", { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://example.com/login");
  });
});
