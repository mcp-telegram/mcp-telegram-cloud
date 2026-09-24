/**
 * Review code entered on the QR page (found 2026-09-18, app rejected 2026-09-24).
 *
 * Directory reviewers started from ChatGPT, landed on the QR page four times,
 * waited five minutes each and rejected the app as "cannot connect to your MCP
 * server". The review LINK only worked if opened first in the same browser, and
 * they never opened it. POST /oauth/authorize/review lets them enter the code
 * where they actually get stuck.
 *
 * These tests pin both halves: the reviewer path must really produce a code for
 * the destination on the page, and it must not become a way to mint codes
 * without the token, for another client, or cross-site.
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
const { extractReviewToken } = await import("../routes/review.js");
const { config } = await import("../config.js");

const ISSUER = config.issuer;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const TOKEN = "0b50d0a04dfe62a849eac2ccba1af0825f6590dc3139cff0";
const DEMO = "demo_account";
const CHATGPT_CB = "https://chatgpt.com/connector/oauth/VvpXtPdK6ukP";

let ipSeq = 0;
/** Fresh client IP per request so the shared review limiter never interferes. */
const nextIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

type Setup = { oauth: InstanceType<typeof OAuthProvider>; app: Hono; clientId: string; reconnects: string[] };

function setup(opts: { sessionAlive?: boolean } = {}): Setup {
  const db = new Database(":memory:");
  const oauth = new OAuthProvider({ issuer: ISSUER, db });
  const reconnects: string[] = [];
  const sessions = {
    resolveReviewToken: (t: string) => (t === TOKEN ? { userId: DEMO, uses: 1 } : null),
    tryReconnectSession: async (userId: string) => {
      reconnects.push(userId);
      return opts.sessionAlive === false ? null : { connected: true };
    },
  } as never;
  const app = new Hono();
  app.route("/oauth", createOAuthRoutes({ oauth, sessions }));
  const clientId = oauth.registerClient({ redirect_uris: [CHATGPT_CB], client_name: "ChatGPT" }).client_id as string;
  return { oauth, app, clientId, reconnects };
}

function post(app: Hono, fields: Record<string, string>, headers: Record<string, string> = { origin: ISSUER }) {
  return app.request("/oauth/authorize/review", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": nextIp(), ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const formFor = (clientId: string, reviewCode: string, over: Record<string, string> = {}) => ({
  client_id: clientId,
  redirect_uri: CHATGPT_CB,
  state: "st",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  review_code: reviewCode,
  ...over,
});

describe("extractReviewToken", () => {
  it("accepts the bare token, the full link and the link without a scheme", () => {
    assert.equal(extractReviewToken(TOKEN), TOKEN);
    assert.equal(extractReviewToken(`  https://mcp.mcp-telegram.com/review?token=${TOKEN}  `), TOKEN);
    assert.equal(extractReviewToken(`mcp.mcp-telegram.com/review?token=${TOKEN}&x=1`), TOKEN);
  });

  it("rejects things that are not a token", () => {
    assert.equal(extractReviewToken(""), "");
    assert.equal(extractReviewToken("short"), "");
    assert.equal(extractReviewToken("<script>alert(1)</script>"), "");
    assert.equal(extractReviewToken("a".repeat(600)), "");
  });
});

describe("POST /oauth/authorize/review — the reviewer gets in from the QR page", () => {
  it("redirects to the page's destination with a code that exchanges for a token", async () => {
    const { oauth, app, clientId, reconnects } = setup();
    const res = await post(app, formFor(clientId, `https://mcp.mcp-telegram.com/review?token=${TOKEN}`));

    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location") ?? "");
    assert.equal(`${loc.origin}${loc.pathname}`, CHATGPT_CB);
    assert.equal(loc.searchParams.get("state"), "st");
    assert.deepEqual(reconnects, [DEMO], "the demo session must be proven live before a code is minted");

    const issued = oauth.exchangeCode({
      code: loc.searchParams.get("code") ?? "",
      clientId,
      codeVerifier: VERIFIER,
      redirectUri: CHATGPT_CB,
    });
    assert.ok(issued, "the code must be a real, exchangeable authorization code");

    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /tg_user=demo_account/, "a later re-authorization must take the fast path");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("records the grant, so a re-authorization from the same destination is silent", async () => {
    const { app, clientId } = setup();
    const res = await post(app, formFor(clientId, TOKEN));
    assert.equal(res.status, 302);

    const again = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CHATGPT_CB)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=s2`,
      { headers: { cookie: `tg_user=${DEMO}` } },
    );
    assert.equal(again.status, 302, "no consent screen for the destination the reviewer already entered a code for");
  });

  it("shows the review-code form on the QR page, carrying the OAuth parameters", async () => {
    const { app, clientId } = setup({ sessionAlive: false });
    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CHATGPT_CB)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=st`,
    );
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /action="\/oauth\/authorize\/review"/);
    assert.match(html, /name="review_code"/);
    assert.match(html, new RegExp(`name="client_id" value="${clientId}"`));
    assert.match(html, /Enter your review code/);
  });
});

describe("fallback authorize page (no React bundle)", () => {
  it("carries the same form and escapes the request values it echoes", async () => {
    const { jsx } = await import("hono/jsx");
    const { AuthorizePage } = await import("../pages/AuthorizePage.js");
    const html = String(
      await jsx(AuthorizePage as never, {
        clientId: "c",
        clientName: "n",
        redirectUri: "https://x.example/cb",
        state: '"><script>alert(1)</script>',
        codeChallenge: "a",
        codeChallengeMethod: "S256",
      }).toString(),
    );
    assert.match(html, /action="\/oauth\/authorize\/review"/);
    assert.match(html, /name="review_code"/);
    assert.ok(!html.includes('"><script>alert(1)'), "state must not break out of the value attribute");
  });
});

describe("POST /oauth/authorize/review — no code without the token", () => {
  it("rejects an unknown code with no redirect and no cookie", async () => {
    const { app, clientId, reconnects } = setup();
    const res = await post(app, formFor(clientId, "f".repeat(48)));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("location"), null);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.deepEqual(reconnects, [], "an unknown code must not even touch a session");
  });

  it("rejects a cross-site post", async () => {
    const { app, clientId } = setup();
    const res = await post(app, formFor(clientId, TOKEN), { origin: "https://evil.example" });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("location"), null);
  });

  it("rejects a post with no Origin at all", async () => {
    const { app, clientId } = setup();
    const res = await post(app, formFor(clientId, TOKEN), {});
    assert.equal(res.status, 403);
  });

  it("refuses a redirect_uri the client did not register", async () => {
    const { app, clientId } = setup();
    const res = await post(app, formFor(clientId, TOKEN, { redirect_uri: "https://evil.example/cb" }));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
  });

  it("refuses a missing or plain PKCE challenge", async () => {
    const { app, clientId } = setup();
    assert.equal((await post(app, formFor(clientId, TOKEN, { code_challenge: "" }))).status, 400);
    assert.equal((await post(app, formFor(clientId, TOKEN, { code_challenge_method: "plain" }))).status, 400);
  });

  it("refuses an unknown client", async () => {
    const { app } = setup();
    assert.equal((await post(app, formFor("nope", TOKEN))).status, 400);
  });

  it("says the demo account is offline instead of minting a code for a dead session", async () => {
    const { app, clientId } = setup({ sessionAlive: false });
    const res = await post(app, formFor(clientId, TOKEN));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("location"), null);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.match(await res.text(), /temporarily offline/);
  });
});
