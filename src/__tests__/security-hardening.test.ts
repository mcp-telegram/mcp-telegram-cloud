/**
 * Security hardening shipped in v2.43.0 (audit findings H1, H2, M1, /mcp limit):
 *   - securityHeaders middleware sets HSTS/CSP/nosniff/frame-deny/referrer
 *   - OAuthProvider.clientCount() + pruneUnusedClients() back the DCR ceiling/GC
 *   - rateLimit honors a custom keyOf (per-token /mcp throttle)
 *
 * Env-before-import (config + crypto resolve env at load).
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { securityHeaders } = await import("../middleware/security-headers.js");
const { rateLimit } = await import("../rate-limit.js");
const { OAuthProvider } = await import("../oauth.js");
const { Database } = await import("bun:sqlite");

describe("securityHeaders middleware", () => {
  it("sets HSTS, CSP, nosniff, frame-deny and referrer-policy", async () => {
    const app = new Hono();
    app.use("*", securityHeaders);
    app.get("/x", (c) => c.text("ok"));
    const res = await app.request("/x");

    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    // scripts must NOT be inline-allowed (islands are external modules)
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    // QR island injects a data: <img>
    assert.match(csp, /img-src 'self' data:/);
  });
});

describe("rateLimit keyOf (per-token /mcp throttle)", () => {
  it("buckets by the custom key, not the IP", async () => {
    const app = new Hono();
    app.use(
      "/mcp",
      rateLimit({
        limit: 2,
        windowMs: 60_000,
        scope: "mcp-test",
        keyOf: (c) => c.req.header("authorization")?.slice(7) ?? null,
      }),
    );
    app.post("/mcp", (c) => c.text("ok"));

    const hit = (token: string) =>
      app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` } });

    // token A: 2 allowed, 3rd is 429
    assert.equal((await hit("tokA")).status, 200);
    assert.equal((await hit("tokA")).status, 200);
    assert.equal((await hit("tokA")).status, 429);
    // token B has its own bucket — unaffected by A exhausting its limit
    assert.equal((await hit("tokB")).status, 200);
  });
});

describe("OAuthProvider client ceiling + prune", () => {
  function setup() {
    const db = new Database(":memory:");
    const oauth = new OAuthProvider({ issuer: "https://test", db });
    return { db, oauth };
  }

  it("clientCount reflects registrations", () => {
    const { oauth } = setup();
    assert.equal(oauth.clientCount(), 0);
    oauth.registerClient({ redirect_uris: ["https://a.test/cb"], client_name: "a" });
    oauth.registerClient({ redirect_uris: ["https://b.test/cb"], client_name: "b" });
    assert.equal(oauth.clientCount(), 2);
  });

  it("pruneUnusedClients deletes old never-authorized clients, keeps used ones", () => {
    const { db, oauth } = setup();
    const used = oauth.registerClient({ redirect_uris: ["https://u.test/cb"], client_name: "used" });
    const unused = oauth.registerClient({ redirect_uris: ["https://x.test/cb"], client_name: "unused" });
    const recent = oauth.registerClient({ redirect_uris: ["https://r.test/cb"], client_name: "recent" });

    // Age the two we want eligible to 40 days ago; leave `recent` fresh.
    db.prepare("UPDATE oauth_clients SET created_at = datetime('now','-40 days') WHERE client_id IN (?, ?)").run(
      used.client_id as string,
      unused.client_id as string,
    );
    // `used` has a live token → must be kept despite age.
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, 0)").run(
      "tok-hash",
      used.client_id as string,
      "alex",
    );

    const deleted = oauth.pruneUnusedClients(30);
    assert.equal(deleted, 1, "only the old + never-authorized client is pruned");
    assert.ok(oauth.getClient(used.client_id as string), "client with a token is kept");
    assert.ok(oauth.getClient(recent.client_id as string), "recent client is kept");
    assert.ok(!oauth.getClient(unused.client_id as string), "old unused client is gone");
  });

  it("pruneUnusedClients with 0 days is a no-op (disabled)", () => {
    const { oauth } = setup();
    oauth.registerClient({ redirect_uris: ["https://a.test/cb"], client_name: "a" });
    assert.equal(oauth.pruneUnusedClients(0), 0);
    assert.equal(oauth.clientCount(), 1);
  });
});
