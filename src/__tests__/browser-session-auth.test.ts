/**
 * Account takeover through a forged `tg_user` cookie (found 2026-09-30).
 *
 * Until 2.61 the browser identified itself with `tg_user=<username>`, and the
 * server believed it. Usernames are public, and Origin is just a header outside
 * a browser, so one curl call was enough to:
 *
 *   - POST /oauth/authorize/approve with the attacker's own client → an
 *     authorization code for the victim's Telegram account;
 *   - GET /oauth/authorize for a destination the victim already uses → a
 *     silent code (the attacker starts the flow from their own Claude account);
 *   - open /my/settings and flip the victim's destructive-tools switch.
 *
 * Each attack below was a success before the fix. Identity now comes only from
 * a server-side browser session that is created after real proof (QR login via
 * a one-time handoff, or a review token).
 */
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://test.invalid";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { Database } = await import("bun:sqlite");
const { OAuthProvider } = await import("../oauth.js");
const { createOAuthRoutes } = await import("../routes/oauth.js");
const { createMyRoutes } = await import("../routes/my.js");
const { config } = await import("../config.js");

const ISSUER = config.issuer;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VICTIM = "victim_user";
const ATTACKER_CB = "https://attacker.example/cb";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

function setup() {
  const db = new Database(":memory:");
  const oauth = new OAuthProvider({ issuer: ISSUER, db });
  const toggles: Array<[string, boolean]> = [];
  const sessions = {
    tryReconnectSession: async () => ({ connected: true }),
    getSavedUserIds: () => [VICTIM],
  } as never;
  const destructive = {
    isEnabled: () => false,
    todayOkCount: () => 0,
    setEnabled: (u: string, v: boolean) => toggles.push([u, v]),
    listForUser: () => [],
  } as never;
  const app = new Hono();
  app.route("/oauth", createOAuthRoutes({ oauth, sessions }));
  app.route("/my", createMyRoutes({ destructive, sessions, uploads: {} as never, oauth }));
  return { oauth, app, toggles };
}

const register = (oauth: InstanceType<typeof OAuthProvider>, cb: string) =>
  oauth.registerClient({ redirect_uris: [cb], client_name: "Claude" }).client_id as string;

function approveForm(clientId: string, redirectUri: string): string {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "s",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  }).toString();
}

const FORGED = { cookie: `tg_user=${VICTIM}`, origin: "" };

describe("a forged tg_user cookie grants nothing", () => {
  it("POST /oauth/authorize/approve does not mint a code for the victim", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, ATTACKER_CB);
    const res = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: {
        cookie: FORGED.cookie,
        origin: ISSUER,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: approveForm(clientId, ATTACKER_CB),
    });
    assert.equal(res.status, 403);
    assert.ok(!(res.headers.get("location") ?? "").includes("code="), "no code for the attacker");
  });

  it("GET /oauth/authorize does not take the silent path for a granted destination", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, CLAUDE_CB);
    oauth.recordGrant(VICTIM, "https://claude.ai");
    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=s`,
      { headers: { cookie: FORGED.cookie } },
    );
    assert.notEqual(res.status, 302, "must show the QR page, not redirect with a code");
    assert.ok(!(await res.text()).includes("code="));
  });

  it("GET /my/settings treats the browser as signed out", async () => {
    const { app } = setup();
    const res = await app.request("/my/settings", { headers: { cookie: FORGED.cookie } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /\/login$/);
  });

  it("POST /my/settings cannot switch on the victim's destructive tools", async () => {
    const { app, toggles } = setup();
    const res = await app.request("/my/settings", {
      method: "POST",
      headers: { cookie: FORGED.cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: "enabled=1",
    });
    assert.equal(res.status, 302);
    assert.deepEqual(toggles, []);
  });

  it("POST /oauth/authorize/qr/cookie ignores a claimed username", async () => {
    const { app } = setup();
    const res = await app.request("/oauth/authorize/qr/cookie", {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({ username: VICTIM }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

describe("a real session (QR handoff) still works", () => {
  async function signIn(app: Hono, oauth: InstanceType<typeof OAuthProvider>): Promise<string> {
    const handoff = oauth.createBrowserHandoff(VICTIM);
    const res = await app.request("/oauth/authorize/qr/cookie", {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({ handoff }),
    });
    assert.equal(res.status, 204);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const sid = setCookie.match(/tg_sid=([0-9a-f]{64})/)?.[1];
    assert.ok(sid, `session cookie expected, got: ${setCookie}`);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /tg_user=;/, "the legacy cookie is cleared");
    return `tg_sid=${sid}`;
  }

  it("the handoff is single-use", async () => {
    const { app, oauth } = setup();
    const handoff = oauth.createBrowserHandoff(VICTIM);
    const post = () =>
      app.request("/oauth/authorize/qr/cookie", {
        method: "POST",
        headers: { origin: ISSUER, "content-type": "application/json" },
        body: JSON.stringify({ handoff }),
      });
    assert.equal((await post()).status, 204);
    assert.equal((await post()).status, 403);
  });

  it("the session opens /my/settings and can toggle the switch (issue #21)", async () => {
    const { app, oauth, toggles } = setup();
    const cookie = await signIn(app, oauth);
    assert.equal((await app.request("/my/settings", { headers: { cookie } })).status, 200);
    const res = await app.request("/my/settings", {
      method: "POST",
      headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: "enabled=1",
    });
    assert.equal(res.status, 303);
    assert.deepEqual(toggles, [[VICTIM, true]]);
  });

  it("the session keeps the silent 302 for a granted destination", async () => {
    const { app, oauth } = setup();
    const cookie = await signIn(app, oauth);
    const clientId = register(oauth, CLAUDE_CB);
    oauth.recordGrant(VICTIM, "https://claude.ai");
    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=s`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 302);
    assert.ok((res.headers.get("location") ?? "").startsWith(`${CLAUDE_CB}?code=`));
  });

  it("the session can approve a new destination on the consent page", async () => {
    const { app, oauth } = setup();
    const cookie = await signIn(app, oauth);
    const clientId = register(oauth, ATTACKER_CB);
    const res = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: approveForm(clientId, ATTACKER_CB),
    });
    assert.equal(res.status, 302);
    assert.ok((res.headers.get("location") ?? "").startsWith(`${ATTACKER_CB}?code=`));
  });

  it("an expired session is ignored", async () => {
    const { oauth } = setup();
    const token = oauth.createBrowserSession(VICTIM, -1);
    assert.equal(oauth.getBrowserSessionUser(token), null);
  });
});
