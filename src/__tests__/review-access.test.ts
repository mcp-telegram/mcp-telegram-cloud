/**
 * Review-access links: the path that lets a directory reviewer reach a prepared
 * demo session without Telegram's device-link QR code.
 *
 * What these tests pin down:
 *   - a fresh token resolves to its session and counts every visit
 *   - REUSABLE on purpose (unlike add-account tokens) — reviewers come back
 *   - revoked and expired tokens stop resolving, and an unknown one never did
 *   - revoking twice reports "nothing changed" the second time
 *   - tokens are stored hashed, so the database never holds a usable secret
 *   - the listing never leaks a working token
 *   - the hint cookie the link writes carries Secure + HttpOnly + SameSite=Lax,
 *     and refuses a value that could break out of the cookie
 *   - GET /review sets that cookie on success, and sets NO cookie when the token
 *     is bad or the demo session is offline
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { buildTgUserCookie } from "../cookie-handler.js";
import type { createReviewRoutes as createReviewRoutesType } from "../routes/review.js";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

// Dynamic: both modules pull in `config.ts`, which validates env at import
// time. A static import is hoisted above the assignments at the top of this
// file and would fail with "Required env var ISSUER is missing".
const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { createReviewRoutes } = (await import("../routes/review.js")) as {
  createReviewRoutes: typeof createReviewRoutesType;
};

class StubTelegramService {
  async connect(): Promise<boolean> {
    return true;
  }
  isConnected(): boolean {
    return true;
  }
  async ensureConnected(): Promise<boolean> {
    return true;
  }
  async disconnect(): Promise<void> {}
  async logOut(): Promise<boolean> {
    return true;
  }
  setSessionString(_s: string): void {}
  getSessionString(): string | undefined {
    return undefined;
  }
}

function makeManager(): SessionManagerType {
  return new SessionManager(":memory:", () => new StubTelegramService() as unknown as TelegramService);
}

const DAY = 24 * 3600;

describe("review tokens — resolution", () => {
  it("resolves to the session it was issued for", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", "OpenAI review", 30 * DAY);
    assert.deepEqual(sm.resolveReviewToken(token), { userId: "demo_account", uses: 1 });
  });

  it("stays valid across visits and counts them", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", null, 30 * DAY);
    assert.equal(sm.resolveReviewToken(token)?.uses, 1);
    assert.equal(sm.resolveReviewToken(token)?.uses, 2);
    // Third visit still works: a single-use token would have failed the second
    // reviewer, which reads to them as "we could not connect".
    assert.equal(sm.resolveReviewToken(token)?.uses, 3);
  });

  it("rejects an unknown token", () => {
    const sm = makeManager();
    assert.equal(sm.resolveReviewToken("0".repeat(48)), null);
  });

  it("rejects an expired token", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", null, -1);
    assert.equal(sm.resolveReviewToken(token), null);
  });
});

describe("review tokens — storage", () => {
  it("stores only a hash, so a leaked database cannot be replayed", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", null, 30 * DAY);
    // Reach into the same file the server would leak in a backup.
    const rows = (sm as unknown as { db: { prepare(q: string): { all(): unknown[] } } }).db
      .prepare("SELECT * FROM review_tokens")
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const dumped = JSON.stringify(rows[0]);
    assert.ok(!dumped.includes(token), "plaintext token must not be in the database");
    assert.match(String(rows[0].token_hash), /^h\d+:[0-9a-f]{64}$/);
  });
});

describe("review tokens — revocation", () => {
  it("stops resolving once revoked", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", null, 30 * DAY);
    assert.ok(sm.resolveReviewToken(token));
    assert.equal(sm.revokeReviewToken(token), true);
    assert.equal(sm.resolveReviewToken(token), null);
  });

  it("reports no change when revoking an unknown token", () => {
    const sm = makeManager();
    assert.equal(sm.revokeReviewToken("0".repeat(48)), false);
  });
});

describe("review tokens — listing", () => {
  it("never returns a usable token", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", "OpenAI review", 30 * DAY);
    const [row] = sm.listReviewTokens();
    assert.ok(row);
    // The listing carries an id, never the secret or any prefix of it.
    assert.equal(typeof row.id, "number");
    assert.ok(!JSON.stringify(row).includes(token.slice(0, 8)));
  });

  it("revokes by the id from the listing, without the token", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", null, 30 * DAY);
    const [row] = sm.listReviewTokens();
    assert.ok(row);
    assert.equal(sm.revokeReviewToken(row.id), true);
    assert.equal(sm.resolveReviewToken(token), null);
  });

  it("shows usage and revocation state", () => {
    const sm = makeManager();
    const token = sm.createReviewToken("demo_account", "note", 30 * DAY);
    sm.resolveReviewToken(token);
    sm.revokeReviewToken(token);
    const [row] = sm.listReviewTokens();
    assert.equal(row?.uses, 1);
    assert.equal(row?.revoked, true);
    assert.equal(row?.note, "note");
    assert.ok(row?.lastUsedAt);
  });
});

/** Minimal SessionManager surface the review route actually touches. */
function routeWith(opts: {
  resolve: { userId: string; uses: number } | null;
  reconnect: boolean;
}): ReturnType<typeof createReviewRoutes> {
  const sessions = {
    resolveReviewToken: () => opts.resolve,
    tryReconnectSession: async () => (opts.reconnect ? ({} as TelegramService) : null),
  } as unknown as SessionManagerType;
  return createReviewRoutes({ sessions });
}

describe("GET /review", () => {
  it("sets the session hint when the token resolves and the session is live", async () => {
    const app = routeWith({ resolve: { userId: "demo_account", uses: 1 }, reconnect: true });
    const res = await app.request("/?token=whatever");
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /tg_user=demo_account/);
    assert.ok(cookie.includes("HttpOnly"));
    // Review runs for months. A 30-day hint would expire between the reviewer
    // opening the link and coming back, dropping them on the QR page they have
    // no way to pass.
    assert.match(cookie, /Max-Age=31536000/);
    // A hint cookie must never be cached by anything in front of us.
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("sets no cookie for a bad token", async () => {
    const app = routeWith({ resolve: null, reconnect: true });
    const res = await app.request("/?token=bad");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("sets no cookie when the token has no token parameter at all", async () => {
    const app = routeWith({ resolve: null, reconnect: true });
    const res = await app.request("/");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("reports the demo session being offline instead of sending the reviewer into a QR dead end", async () => {
    const app = routeWith({ resolve: { userId: "demo_account", uses: 1 }, reconnect: false });
    const res = await app.request("/?token=whatever");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

describe("session-hint cookie", () => {
  it("carries the flags the OAuth fast path depends on", () => {
    const cookie = buildTgUserCookie("demo_account");
    assert.match(cookie, /^tg_user=demo_account;/);
    for (const flag of ["Path=/", "SameSite=Lax", "Secure", "HttpOnly"]) {
      assert.ok(cookie.includes(flag), `missing ${flag}`);
    }
  });

  it("refuses a value that could break out of the cookie", () => {
    for (const bad of ["a; Domain=evil.test", "a\r\nSet-Cookie: x=1", "", "a".repeat(65)]) {
      assert.throws(() => buildTgUserCookie(bad), /unsafe tg_user value/);
    }
  });
});
