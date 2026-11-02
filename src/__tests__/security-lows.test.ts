/**
 * Low-severity findings of the security audit (2026-11-02), one guard each:
 * - rate limits key on issued tokens only, a made-up token falls back to the IP;
 * - client registration refuses redirect URIs a browser would execute or that leak codes;
 * - add-account links are stored hashed;
 * - the access log never writes a capability-bearing path.
 */
process.env.ISSUER ??= "https://security-lows.invalid";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { Hono } from "hono";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { Database } = await import("bun:sqlite");
const { OAuthProvider } = await import("../oauth.js");
const { createOAuthRoutes } = await import("../routes/oauth.js");
const { issuedBearerKey, rateLimit } = await import("../rate-limit.js");
const { isAllowedRedirectUri } = await import("../redirect-uri-matcher.js");
const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { hashToken } = await import("../crypto.js");
const { logger } = await import("../logger.js");
const { accessLog } = await import("../middleware/access-log.js");

describe("rate limit keys", () => {
  it("a made-up bearer token gets no bucket of its own", async () => {
    const app = new Hono();
    app.use(
      "/x",
      rateLimit({ limit: 2, windowMs: 60_000, scope: "lows", keyOf: issuedBearerKey((t) => t === "real") }),
    );
    app.get("/x", (c) => c.text("ok"));
    const hit = (token: string) =>
      app.request("/x", { headers: { Authorization: `Bearer ${token}`, "X-Real-IP": "198.51.100.9" } });

    // Fresh random tokens used to dodge the limit forever; now they share the IP bucket.
    assert.equal((await hit("fake-1")).status, 200);
    assert.equal((await hit("fake-2")).status, 200);
    assert.equal((await hit("fake-3")).status, 429);
    // An issued token keeps its own bucket, so users behind one IP do not starve each other.
    assert.equal((await hit("real")).status, 200);
  });
});

describe("redirect URIs at registration", () => {
  it("allows https, loopback http and app schemes; refuses executable or leaky ones", () => {
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost:3334/cb",
      "http://127.0.0.1:5000/cb",
      "cursor://anysphere.cursor-mcp/oauth/callback",
    ]) {
      assert.equal(isAllowedRedirectUri(ok), true, ok);
    }
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "http://evil.example/cb",
      "not a url",
    ]) {
      assert.equal(isAllowedRedirectUri(bad), false, bad);
    }
  });

  it("POST /register answers 400 for a javascript: redirect", async () => {
    const db = new Database(":memory:");
    const oauth = new OAuthProvider({ issuer: process.env.ISSUER as string, db });
    const app = new Hono();
    app.route("/oauth", createOAuthRoutes({ oauth, sessions: {} as never }));
    const res = await app.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": "198.51.100.10" },
      body: JSON.stringify({ redirect_uris: ["javascript:alert(document.cookie)"], client_name: "x" }),
    });
    assert.equal(res.status, 400);
  });
});

describe("add-account links", () => {
  it("are stored hashed, still work once, and the stored form is not a link", () => {
    const sm = new SessionManager(":memory:", () => ({}) as unknown as TelegramService);
    const token = sm.createAddAccountToken("alice", "work", 600);
    const stored = (sm.getDb().prepare("SELECT token FROM add_account_tokens").get() as { token: string }).token;
    assert.equal(stored, hashToken(token));
    assert.equal(sm.peekAddAccountToken(stored), null, "a hash copied from the database is not a link");
    assert.equal(sm.consumeAddAccountToken(token)?.ownerUserId, "alice");
    assert.equal(sm.consumeAddAccountToken(token), null, "single use");
  });
});

describe("access log", () => {
  it("writes the templated route, not the token in the path", async () => {
    const lines: string[] = [];
    const orig = logger.info;
    (logger as { info: typeof logger.info }).info = (msg: string, attrs?: Record<string, unknown>) => {
      lines.push(`${msg} ${JSON.stringify(attrs ?? {})}`);
    };
    try {
      const app = new Hono();
      app.use("*", accessLog);
      app.get("/accounts/add/:t", (c) => c.text("ok"));
      const token = "a3f9".repeat(12);
      await app.request(`/accounts/add/${token}`);
      assert.ok(lines.length > 0);
      assert.ok(!lines.some((l) => l.includes(token)), "token must not appear in the log");
    } finally {
      (logger as { info: typeof logger.info }).info = orig;
    }
  });
});
