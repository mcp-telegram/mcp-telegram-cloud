/**
 * form-action on the OAuth pages (found 2026-10-13 in a clean Chrome profile).
 *
 * The review-code form and the consent form POST to our origin and answer with a
 * 302 to the client's redirect_uri. Browsers enforce CSP form-action on that
 * redirect as well, so with bare `form-action 'self'` Chrome blocked it and the
 * reviewer was left on the page after pressing Continue. Scripted checks posted
 * the form directly and never saw it.
 *
 * The page that holds the form must therefore allow exactly the destination it
 * names — and nothing wider.
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
const { securityHeaders, formActionSource } = await import("../middleware/security-headers.js");
const { config } = await import("../config.js");

const ISSUER = config.issuer;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const TOKEN = "3c1f0e9a7b5d2c4e6f8a0b1c3d5e7f9a1b3c5d7e9f0a2b4c";
const CHATGPT_CB = "https://chatgpt.com/connector_platform_oauth_redirect";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const CURSOR_CB = "cursor://anysphere.cursor-mcp/oauth/callback";

let ipSeq = 0;
const nextIp = () => `10.8.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

function setup() {
  const db = new Database(":memory:");
  const oauth = new OAuthProvider({ issuer: ISSUER, db });
  const sessions = {
    resolveReviewToken: (t: string) => (t === TOKEN ? { userId: "demo", uses: 1, note: null } : null),
    tryReconnectSession: async () => ({ connected: true }),
  } as never;
  const app = new Hono();
  app.use("*", securityHeaders);
  app.route("/oauth", createOAuthRoutes({ oauth, sessions }));
  const register = (redirect: string) =>
    oauth.registerClient({ redirect_uris: [redirect], client_name: "Client" }).client_id as string;
  return { app, register };
}

const authorizeUrl = (clientId: string, redirect: string) =>
  `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=s`;

const formAction = (res: Response) =>
  (res.headers.get("content-security-policy") ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("form-action"));

describe("OAuth pages allow their form to reach the named destination", () => {
  it("the QR page (review-code form) allows the client's redirect origin", async () => {
    const { app, register } = setup();
    const res = await app.request(authorizeUrl(register(CHATGPT_CB), CHATGPT_CB));

    assert.equal(res.status, 200);
    assert.equal(formAction(res), "form-action 'self' https://chatgpt.com");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/, "the rest of the policy is unchanged");
    assert.match(csp, /script-src 'self'(;|$)/);
  });

  it("the consent page allows its own destination only", async () => {
    const { app, register } = setup();
    const chatgpt = register(CHATGPT_CB);
    const login = await app.request("/oauth/authorize/review", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, "x-real-ip": nextIp() },
      body: new URLSearchParams({
        client_id: chatgpt,
        redirect_uri: CHATGPT_CB,
        state: "s",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        review_code: TOKEN,
      }).toString(),
    });
    assert.equal(login.status, 302);
    const sid = (login.headers.get("set-cookie") ?? "").match(/tg_sid=[0-9a-f]{64}/)?.[0] ?? "";
    assert.ok(sid, "the review login sets a browser session");

    const res = await app.request(authorizeUrl(register(CLAUDE_CB), CLAUDE_CB), { headers: { cookie: sid } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /\/oauth\/authorize\/approve/, "an unconnected destination gets the consent form");
    assert.equal(formAction(res), "form-action 'self' https://claude.ai");
  });

  it("an app callback scheme is allowed as a scheme source", async () => {
    const { app, register } = setup();
    const res = await app.request(authorizeUrl(register(CURSOR_CB), CURSOR_CB));
    assert.equal(formAction(res), "form-action 'self' cursor:");
  });

  it("responses without such a form keep the strict default", async () => {
    const { app } = setup();
    const res = await app.request(authorizeUrl("unknown-client", CHATGPT_CB));
    assert.equal(res.status, 400);
    assert.equal(formAction(res), "form-action 'self'");
  });
});

describe("formActionSource", () => {
  it("maps redirect URIs to one safe CSP source token", () => {
    assert.equal(formActionSource("https://chatgpt.com/a/b?c=d#e"), "https://chatgpt.com");
    assert.equal(formActionSource("http://127.0.0.1:33418/callback"), "http://127.0.0.1:33418");
    assert.equal(formActionSource("vscode://ms-vscode.copilot/cb"), "vscode:");
    assert.equal(formActionSource("not a url"), null);
    assert.equal(formActionSource(""), null);
  });
});
