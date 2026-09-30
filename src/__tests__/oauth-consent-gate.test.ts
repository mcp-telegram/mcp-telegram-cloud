/**
 * Silent-authorization hole (found + verified against production 2026-09-21).
 *
 * `/oauth/authorize` minted an authorization code from nothing but the ambient
 * `tg_user` cookie. Registration is open (RFC 7591), the cookie is SameSite=Lax
 * (so it rides along on an ordinary top-level link click) and PKCE does not
 * help because the attacker picks their own verifier. Reproduced live:
 *
 *   curl -H 'Cookie: tg_user=overpod' '.../oauth/authorize?client_id=<mine>&redirect_uri=https://example.com/cb&…'
 *   → 302 https://example.com/cb?code=50f6b148…
 *
 * The fix gates the silent path on a per-destination grant. These tests pin
 * BOTH halves, because either one alone is a defect:
 *   - unknown destination must NOT produce a code without a human action;
 *   - a destination the user already uses must keep the silent 302, or every
 *     existing Claude/ChatGPT/Cursor user gets an unexpected screen.
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
const { redirectOrigin } = await import("../redirect-origin.js");
const { config } = await import("../config.js");

// Read the issuer back from config instead of repeating the literal: every
// test file sets ISSUER with `??=`, so in a shared test process the FIRST file
// loaded wins and a hard-coded copy silently stops matching the Origin check
// (observed: this suite passed alone and failed next to another test file).
const ISSUER = config.issuer;
const PKCE = "code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256";
const USER = "victim";

/** A real browser session for USER (the cookie a finished QR login leaves behind). */
const sessionCookie = (oauth: InstanceType<typeof OAuthProvider>) => `tg_sid=${oauth.createBrowserSession(USER, 3600)}`;

type Deps = { oauth: InstanceType<typeof OAuthProvider>; app: Hono };

/** Real provider + real routes; only the Telegram session layer is a double. */
function setup(opts: { sessionAlive?: boolean } = {}): Deps {
  const db = new Database(":memory:");
  const oauth = new OAuthProvider({ issuer: ISSUER, db });
  const sessions = {
    tryReconnectSession: async () => (opts.sessionAlive === false ? null : { connected: true }),
  } as never;
  const app = new Hono();
  app.route("/oauth", createOAuthRoutes({ oauth, sessions }));
  return { oauth, app };
}

function register(oauth: Deps["oauth"], redirectUri: string, name: string): string {
  return oauth.registerClient({ redirect_uris: [redirectUri], client_name: name }).client_id as string;
}

const authorizeUrl = (clientId: string, redirectUri: string) =>
  `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&${PKCE}&state=s`;

describe("GET /oauth/authorize — unknown destination cannot mint a code silently", () => {
  it("shows a confirmation page instead of redirecting with a code", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, "https://evil.example/cb", "Claude"); // name is attacker-chosen on purpose

    const res = await app.request(authorizeUrl(clientId, "https://evil.example/cb"), {
      headers: { cookie: sessionCookie(oauth) },
    });

    assert.equal(res.status, 200, "must not be a 302 to the attacker");
    assert.equal(res.headers.get("location"), null, "no Location header at all");
    const html = await res.text();
    assert.ok(!html.includes("code="), "no authorization code anywhere in the response");
    // The host is the part the attacker cannot fake; the page must show it.
    assert.match(html, /evil\.example/, "the real destination must be visible to the human");
  });

  it("keeps the silent 302 for a destination the user already granted", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, "https://claude.ai/api/mcp/auth_callback", "Claude");
    oauth.recordGrant(USER, "https://claude.ai");

    const res = await app.request(authorizeUrl(clientId, "https://claude.ai/api/mcp/auth_callback"), {
      headers: { cookie: sessionCookie(oauth) },
    });

    assert.equal(res.status, 302);
    const loc = res.headers.get("location") ?? "";
    assert.ok(loc.startsWith("https://claude.ai/api/mcp/auth_callback?code="), loc);
    assert.match(loc, /state=s/);
  });

  it("grandfathers users who already hold a token for that destination (no re-consent)", async () => {
    // The production case: nobody has a grant row on the day this ships, but
    // every active user has tokens. They must not be interrupted.
    const { oauth, app } = setup();
    const oldClient = register(oauth, "https://claude.ai/api/mcp/auth_callback", "Claude");
    const code = oauth.createAuthCode({
      clientId: oldClient,
      userId: USER,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
    });
    const issued = oauth.exchangeCode({
      code,
      clientId: oldClient,
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
    });
    assert.ok(issued, "precondition: the user holds a token");

    // Claude re-registers on every reconnect — brand-new client_id, same host.
    const freshClient = register(oauth, "https://claude.ai/api/mcp/auth_callback", "Claude");
    const res = await app.request(authorizeUrl(freshClient, "https://claude.ai/api/mcp/auth_callback"), {
      headers: { cookie: sessionCookie(oauth) },
    });

    assert.equal(res.status, 302, "a returning user must not be asked to confirm again");
  });

  it("names the destination on the QR page too, since scanning is the consent act", async () => {
    // A first-time victim has no session, so they land on the QR page rather
    // than the consent page. That page used to show only `client_name`, which
    // the attacker picks at registration \u2014 "Claude" pointing at evil.example.
    const { oauth, app } = setup({ sessionAlive: false });
    const clientId = register(oauth, "https://evil.example/cb", "Claude");

    const res = await app.request(authorizeUrl(clientId, "https://evil.example/cb"));
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /evil\.example/, "the delivery destination must be on the page");
    assert.match(html, /Access code will be sent to/i);
  });

  it("does not let one approved destination approve another", async () => {
    const { oauth, app } = setup();
    oauth.recordGrant(USER, "https://claude.ai");
    const evil = register(oauth, "https://evil.example/cb", "Claude");

    const res = await app.request(authorizeUrl(evil, "https://evil.example/cb"), {
      headers: { cookie: sessionCookie(oauth) },
    });
    assert.equal(res.status, 200);
  });

  it("still serves the QR page when there is no session at all", async () => {
    const { oauth, app } = setup({ sessionAlive: false });
    const clientId = register(oauth, "https://claude.ai/api/mcp/auth_callback", "Claude");

    const res = await app.request(authorizeUrl(clientId, "https://claude.ai/api/mcp/auth_callback"), {
      headers: { cookie: sessionCookie(oauth) },
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /qr-section|Scan|Connect your Telegram/i);
  });
});

describe("POST /oauth/authorize/approve", () => {
  const body = (clientId: string, redirectUri: string) =>
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });

  it("issues the code and remembers the destination", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, "https://newtool.example/cb", "NewTool");

    const res = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: { cookie: sessionCookie(oauth), origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: body(clientId, "https://newtool.example/cb"),
    });

    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^https:\/\/newtool\.example\/cb\?code=/);
    assert.equal(oauth.hasGrant(USER, "https://newtool.example"), true, "approval must persist");

    // And the next visit is silent, so confirming is a one-time cost.
    const again = await app.request(authorizeUrl(clientId, "https://newtool.example/cb"), {
      headers: { cookie: sessionCookie(oauth) },
    });
    assert.equal(again.status, 302);
  });

  it("rejects a cross-site submission (wrong Origin)", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, "https://evil.example/cb", "Evil");

    const res = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: {
        cookie: sessionCookie(oauth),
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body(clientId, "https://evil.example/cb"),
    });

    assert.equal(res.status, 403);
    assert.equal(oauth.hasGrant(USER, "https://evil.example"), false);
  });

  it("refuses without a session cookie", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, "https://newtool.example/cb", "NewTool");

    const res = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: body(clientId, "https://newtool.example/cb"),
    });
    assert.equal(res.status, 403);
  });

  it("refuses when the cookie names a session that does not resolve", async () => {
    const { oauth, app } = setup({ sessionAlive: false });
    const clientId = register(oauth, "https://newtool.example/cb", "NewTool");

    const res = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: { cookie: sessionCookie(oauth), origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: body(clientId, "https://newtool.example/cb"),
    });
    assert.equal(res.status, 403);
  });

  it("re-validates the form fields instead of trusting them", async () => {
    const { oauth, app } = setup();
    const clientId = register(oauth, "https://newtool.example/cb", "NewTool");

    // redirect_uri swapped for one this client never registered
    const tampered = body(clientId, "https://attacker.example/cb");
    const res = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: { cookie: sessionCookie(oauth), origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: tampered,
    });
    assert.equal(res.status, 400);

    // PKCE downgrade
    const noPkce = body(clientId, "https://newtool.example/cb");
    noPkce.set("code_challenge_method", "plain");
    const res2 = await app.request("/oauth/authorize/approve", {
      method: "POST",
      headers: { cookie: sessionCookie(oauth), origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: noPkce,
    });
    assert.equal(res2.status, 400);
  });
});

describe("redirectOrigin", () => {
  it("keeps distinct destinations distinct", () => {
    assert.equal(redirectOrigin("https://claude.ai/api/mcp/auth_callback"), "https://claude.ai");
    assert.equal(redirectOrigin("https://chatgpt.com/connector/oauth/VvpXtPdK6ukP"), "https://chatgpt.com");
    assert.notEqual(redirectOrigin("https://evil.example/cb"), redirectOrigin("https://claude.ai/cb"));
  });

  it("does not collapse custom schemes into one bucket (URL.origin returns 'null' for them)", () => {
    const cursor = redirectOrigin("cursor://anysphere.cursor-mcp/oauth/callback");
    const other = redirectOrigin("evilapp://anysphere.cursor-mcp/oauth/callback");
    const otherHost = redirectOrigin("cursor://someone-else/oauth/callback");
    assert.equal(cursor, "cursor://anysphere.cursor-mcp");
    assert.notEqual(cursor, other);
    assert.notEqual(cursor, otherHost);
  });

  it("separates loopback ports", () => {
    assert.notEqual(redirectOrigin("http://localhost:6274/cb"), redirectOrigin("http://localhost:8765/cb"));
  });

  it("ignores query and fragment, and rejects garbage", () => {
    assert.equal(redirectOrigin("https://a.example/cb?x=1#f"), "https://a.example");
    assert.equal(redirectOrigin("not a url"), null);
  });
});
