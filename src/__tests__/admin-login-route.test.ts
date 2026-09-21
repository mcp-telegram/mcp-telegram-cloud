process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??=
  "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildAdminSessionCookie } = await import("../auth/admin.js");
const { createAdminLoginRoutes } = await import("../routes/admin-login.js");

function makeApp() {
  return createAdminLoginRoutes();
}

describe("GET /admin-login", () => {
  it("renders the login form when not authenticated (200, html body)", async () => {
    const res = await makeApp().request("/?returnTo=/oauth/authorize%3Ffoo%3Dbar");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<form/);
  });

  it("redirects straight to returnTo when already authenticated", async () => {
    const cookie = buildAdminSessionCookie().split(";")[0];
    const res = await makeApp().request("/?returnTo=/oauth/authorize%3Ffoo%3Dbar", {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/oauth/authorize?foo=bar");
  });

  it("rejects double-slash returnTo (open redirect attack)", async () => {
    const res = await makeApp().request("/?returnTo=%2F%2Fevil.example", {
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<form/);
    // Redirects to root form, not to evil.example
  });

  it("rejects backslash returnTo (open redirect attack)", async () => {
    const res = await makeApp().request("/?returnTo=%2F%5Cevil.example", {
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<form/);
    // Redirects to root form, not to evil.example
  });
});

describe("POST /admin-login", () => {
  it("sets the cookie and redirects to returnTo on correct credentials", async () => {
    const res = await makeApp().request("/?returnTo=%2Fmy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=s3cret-pw",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/my");
    assert.match(res.headers.get("set-cookie") ?? "", /admin_session=/);
  });

  it("rejects a wrong password without setting a cookie", async () => {
    const res = await makeApp().request("/?returnTo=%2Fmy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=nope",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /error=1/);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("rejects a wrong username without setting a cookie", async () => {
    const res = await makeApp().request("/?returnTo=%2Fmy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=mallory&password=s3cret-pw",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("rejects double-slash returnTo after login (open redirect attack)", async () => {
    const res = await makeApp().request("/?returnTo=%2F%2Fevil.example", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=s3cret-pw",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.match(res.headers.get("set-cookie") ?? "", /admin_session=/);
  });

  it("rejects backslash returnTo after login (open redirect attack)", async () => {
    const res = await makeApp().request("/?returnTo=%2F%5Cevil.example", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=s3cret-pw",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.match(res.headers.get("set-cookie") ?? "", /admin_session=/);
  });
});
