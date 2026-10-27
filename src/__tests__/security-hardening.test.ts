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
const { OAuthProvider, REVIEW_KEEP_MAX, REVIEW_REDIRECT_ORIGINS } = await import("../oauth.js");
const { createOAuthRoutes } = await import("../routes/oauth.js");
const { config } = await import("../config.js");
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
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
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

/** Total rows in oauth_clients. */
const clientCount = (db: InstanceType<typeof Database>) =>
  (db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n;

describe("OAuthProvider client ceiling + prune", () => {
  function setup() {
    const db = new Database(":memory:");
    const oauth = new OAuthProvider({ issuer: "https://test", db });
    return { db, oauth };
  }

  it("registrations are stored", () => {
    const { db, oauth } = setup();
    assert.equal(clientCount(db), 0);
    oauth.registerClient({ redirect_uris: ["https://a.test/cb"], client_name: "a" });
    oauth.registerClient({ redirect_uris: ["https://b.test/cb"], client_name: "b" });
    assert.equal(clientCount(db), 2);
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
    const { db, oauth } = setup();
    oauth.registerClient({ redirect_uris: ["https://a.test/cb"], client_name: "a" });
    assert.equal(oauth.pruneUnusedClients(0), 0);
    assert.equal(clientCount(db), 1);
  });

  // cloud#43: authorized clients are real users, not a DCR flood; they must not eat the ceiling.
  it("pendingClientCount counts only clients that never authorized", () => {
    const { db, oauth } = setup();
    const used = oauth.registerClient({ redirect_uris: ["https://u.test/cb"], client_name: "used" });
    oauth.registerClient({ redirect_uris: ["https://x.test/cb"], client_name: "unused" });
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, 0)").run(
      "tok-hash",
      used.client_id as string,
      "alex",
    );
    assert.equal(clientCount(db), 2);
    assert.equal(oauth.pendingClientCount(), 1);
  });

  // Review rule 4: a directory app registers once and the reviewer may authorize weeks later.
  it("pruneUnusedClients keeps directory-app clients when asked to", () => {
    const { db, oauth } = setup();
    const chatgpt = oauth.registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "ChatGPT",
    });
    const claude = oauth.registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
    });
    const other = oauth.registerClient({ redirect_uris: ["https://x.test/cb"], client_name: "other" });
    db.prepare("UPDATE oauth_clients SET created_at = datetime('now','-40 days')").run();

    assert.equal(oauth.pruneUnusedClients(30, REVIEW_REDIRECT_ORIGINS), 1);
    assert.ok(oauth.getClient(chatgpt.client_id as string), "ChatGPT client kept during review");
    assert.ok(oauth.getClient(claude.client_id as string), "Claude client kept during review");
    assert.ok(!oauth.getClient(other.client_id as string), "unrelated client still pruned");

    // Review over: the same clients are ordinary abandoned registrations again.
    assert.equal(oauth.pruneUnusedClients(30), 2);
    assert.equal(clientCount(db), 0);
  });
});

describe("review-origin protection cannot be abused to fill the ceiling (cloud#43)", () => {
  function aged(db: InstanceType<typeof Database>) {
    db.prepare("UPDATE oauth_clients SET created_at = datetime('now','-40 days')").run();
  }

  it("one chatgpt.com URI among others does not protect a registration", () => {
    const db = new Database(":memory:");
    const oauth = new OAuthProvider({ issuer: "https://test", db });
    const mixed = oauth.registerClient({
      redirect_uris: ["https://evil.test/cb", "https://chatgpt.com/unused"],
      client_name: "ChatGPT",
    });
    aged(db);
    assert.equal(oauth.pruneUnusedClients(30, REVIEW_REDIRECT_ORIGINS), 1);
    assert.ok(!oauth.getClient(mixed.client_id as string));
  });

  it("keeps at most REVIEW_KEEP_MAX directory-app clients, the newest ones", () => {
    const db = new Database(":memory:");
    const oauth = new OAuthProvider({ issuer: "https://test", db });
    const ids: string[] = [];
    for (let i = 0; i < REVIEW_KEEP_MAX + 3; i++) {
      ids.push(
        oauth.registerClient({ redirect_uris: ["https://chatgpt.com/cb"], client_name: `c${i}` }).client_id as string,
      );
    }
    aged(db);
    assert.equal(oauth.pruneUnusedClients(30, REVIEW_REDIRECT_ORIGINS), 3);
    assert.equal(clientCount(db), REVIEW_KEEP_MAX);
    for (const id of ids.slice(0, 3)) assert.ok(!oauth.getClient(id), "oldest beyond the cap are pruned");
    assert.ok(oauth.getClient(ids[ids.length - 1] as string), "newest is kept");
  });
});

describe("client prune stays fast at the ceiling (cloud#43)", () => {
  // Per-row NOT IN rebuilt the token sets for every client: ~33 s for this data set, run
  // synchronously by the hourly timer. Indexed probes take tens of milliseconds.
  it("prunes 5000 stale clients next to 2500 authorized ones in well under a second", () => {
    const db = new Database(":memory:");
    const oauth = new OAuthProvider({ issuer: "https://test", db });
    const ins = db.prepare(
      "INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, client_name, created_at) VALUES (?, '', '[\"https://x.test/cb\"]', 'c', datetime('now','-40 days'))",
    );
    const tok = db.prepare(
      "INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, 'u', 0)",
    );
    const rt = db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, 'u', 0, '')",
    );
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) ins.run(`stale${i}`);
      for (let i = 0; i < 2500; i++) {
        ins.run(`auth${i}`);
        tok.run(`t${i}`, `auth${i}`);
      }
      for (let i = 0; i < 7500; i++) rt.run(`r${i}`, `auth${i % 2500}`);
    })();
    const started = performance.now();
    assert.equal(oauth.pruneUnusedClients(30), 5000);
    assert.ok(performance.now() - started < 1000, "prune must not block the event loop for seconds");
    assert.equal(clientCount(db), 2500);
  });
});

describe("POST /oauth/register input handling (cloud#43)", () => {
  function setupApp() {
    const db = new Database(":memory:");
    const oauth = new OAuthProvider({ issuer: "https://test", db });
    const app = new Hono();
    app.route("/oauth", createOAuthRoutes({ oauth, sessions: {} as never }));
    return { db, oauth, app };
  }
  // Distinct per request: registration is limited per IP.
  let ip = 0;
  const register = (app: Hono, body: string, contentType = "application/json") =>
    app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": contentType, "x-forwarded-for": `10.0.0.${++ip}` },
      body,
    });

  it("answers 400, not 500, to a body that is not a JSON object", async () => {
    const { db, app } = setupApp();
    for (const [body, type] of [
      ["not json", "application/json"],
      ["", "application/json"],
      ["null", "application/json"],
      ["[]", "application/json"],
      ["redirect_uris=https://a.test/cb", "application/x-www-form-urlencoded"],
    ]) {
      const res = await register(app, body, type);
      assert.equal(res.status, 400, `body ${JSON.stringify(body)}`);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_client_metadata");
    }
    assert.equal(clientCount(db), 0);
  });

  it("rejects redirect_uris entries that are not strings", async () => {
    const { db, app } = setupApp();
    const res = await register(app, JSON.stringify({ redirect_uris: [1] }));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_redirect_uri");
    assert.equal(clientCount(db), 0);
  });

  it("still registers a well-formed client", async () => {
    const { app } = setupApp();
    const res = await register(
      app,
      JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }),
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { client_id: string; client_name: string };
    assert.ok(body.client_id);
    assert.equal(body.client_name, "Claude");
  });

  it("authorized clients do not count toward the registration ceiling", async () => {
    const { db, app, oauth } = setupApp();
    const original = config.maxOauthClients;
    config.maxOauthClients = 1;
    try {
      const used = oauth.registerClient({ redirect_uris: ["https://u.test/cb"], client_name: "used" });
      db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, 0)").run(
        "tok-hash",
        used.client_id as string,
        "alex",
      );
      const ok = await register(app, JSON.stringify({ redirect_uris: ["https://a.test/cb"] }));
      assert.equal(ok.status, 201, "one authorized client must not exhaust a ceiling of 1");
      const full = await register(app, JSON.stringify({ redirect_uris: ["https://b.test/cb"] }));
      assert.equal(full.status, 503, "the never-authorized client now fills the ceiling");
    } finally {
      config.maxOauthClients = original;
    }
  });
});
