/**
 * A reviewer's "Disconnect" must not kill the shared demo account (found 2026-09-29).
 *
 * On 2026-09-25 a single OAuth revoke against the review-link account ran the normal
 * cleanup: destroyUserSession() logged the account out of Telegram and every token of
 * the account was revoked. The review code stayed valid but led to "demo account is
 * temporarily offline" for the rest of an OpenAI directory review.
 *
 * Pinned here: for an account behind a live review link, /oauth/revoke revokes only the
 * presented token and leaves the Telegram session and other reviewers' tokens alone.
 * Every other account keeps the full cleanup (logout + revoke all).
 */
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://test.invalid";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Hono } from "hono";

const { Database } = await import("bun:sqlite");
const { OAuthProvider } = await import("../oauth.js");
const { createOAuthRoutes } = await import("../routes/oauth.js");
const { SessionManager } = await import("../session-manager.js");
const { config } = await import("../config.js");

const DEMO = "demo_account";
const REGULAR = "regular_user";
const CB = "https://chatgpt.com/connector/oauth/abc";
const dir = mkdtempSync(join(tmpdir(), "revoke-review-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let dbSeq = 0;

function setup() {
  const sessions = new SessionManager(join(dir, `s-${dbSeq++}.db`));
  const oauth = new OAuthProvider({ issuer: config.issuer, db: new Database(":memory:") });
  const destroyed: string[] = [];
  // The only thing stubbed is the Telegram-side logout itself.
  sessions.destroyUserSession = async (userId: string) => {
    destroyed.push(userId);
    return { loggedOut: true };
  };
  const app = new Hono();
  app.route("/oauth", createOAuthRoutes({ oauth, sessions }));
  const clientId = oauth.registerClient({ redirect_uris: [CB], client_name: "ChatGPT" }).client_id as string;
  return { sessions, oauth, app, clientId, destroyed };
}

function issue(s: ReturnType<typeof setup>, userId: string): string {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const code = s.oauth.createAuthCode({
    clientId: s.clientId,
    userId,
    redirectUri: CB,
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    codeChallengeMethod: "S256",
  });
  const tokens = s.oauth.exchangeCode({ code, clientId: s.clientId, redirectUri: CB, codeVerifier: verifier });
  assert.ok(tokens && "access_token" in tokens, "token exchange failed in setup");
  return (tokens as { access_token: string }).access_token;
}

const revoke = (app: Hono, token: string) =>
  app.request("/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });

describe("POST /oauth/revoke on a review-link account", () => {
  it("revokes only the presented token and keeps the Telegram session", async () => {
    const s = setup();
    s.sessions.createReviewToken(DEMO, "openai", 3600);
    const reviewerA = issue(s, DEMO);
    const reviewerB = issue(s, DEMO);

    const res = await revoke(s.app, reviewerA);

    assert.equal(res.status, 200);
    assert.deepEqual(s.destroyed, [], "demo account was logged out of Telegram");
    assert.equal(s.oauth.validateToken(reviewerA), null, "the presented token must be revoked");
    assert.ok(s.oauth.validateToken(reviewerB), "another reviewer's token was revoked too");
  });

  it("a revoked or expired review link no longer shields the account", async () => {
    const s = setup();
    s.sessions.createReviewToken(DEMO, "expired", -10);
    const token = issue(s, DEMO);

    await revoke(s.app, token);

    assert.deepEqual(s.destroyed, [DEMO]);
  });

  it("regular accounts keep the full cleanup: logout and every token revoked", async () => {
    const s = setup();
    s.sessions.createReviewToken(DEMO, "openai", 3600);
    const first = issue(s, REGULAR);
    const second = issue(s, REGULAR);

    await revoke(s.app, first);

    assert.deepEqual(s.destroyed, [REGULAR]);
    assert.equal(s.oauth.validateToken(second), null, "the user's other tokens must be revoked");
  });
});
