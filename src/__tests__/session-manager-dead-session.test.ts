/**
 * cloud#42 — a session Telegram has revoked must stop being retried.
 *
 * Seen on prod 2026-10-27: one user's client opened a new MCP session every few minutes and
 * each one ran a fresh connect against an auth key Telegram had already thrown away (137
 * attempts in 6 hours). Nothing ended the loop: the stored session stayed and the OAuth
 * token kept working, so the client never learned it had to reconnect.
 *
 * Driven through the real cleanup (`createDeadSessionHandler` + `OAuthProvider`), so every
 * test asserts the outcome — stored session gone, tokens revoked — not merely that a
 * callback was entered. The negative cases pin what must survive: network trouble, the
 * demo account behind a live review link, a session a concurrent QR login just replaced,
 * and a dead secondary account that is not the owner's primary session.
 */
process.env.ISSUER ??= "https://dead-session-test.invalid";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { OAuthProvider } = await import("../oauth.js");
const { createDeadSessionHandler } = await import("../mcp-handler.js");
const { decryptSecret } = await import("../crypto.js");

/** What upstream `connect()` writes into `lastError` for AUTH_KEY_UNREGISTERED / SESSION_REVOKED. */
const REVOKED = "Session revoked. Run telegram-login to re-authenticate.";
const NETWORK = "Network error: TIMEOUT. Run telegram-status to retry connection.";

type Mode = "ok" | "revoked" | "network";

/** Telegram double: answers every connect attempt according to the test's current mode. */
class StubTelegram {
  lastError = "";
  logouts = 0;
  private connected = false;
  private session = "";
  constructor(
    private readonly mode: () => Mode,
    private readonly gate: () => Promise<void>,
  ) {}
  setSessionString(s: string): void {
    this.session = s;
  }
  getSessionString(): string {
    return this.session;
  }
  async connect(): Promise<boolean> {
    await this.gate();
    return this.answer();
  }
  async ensureConnected(): Promise<boolean> {
    return this.connected || this.answer();
  }
  isConnected(): boolean {
    return this.connected;
  }
  /** The socket went away; the next ensureConnected() asks Telegram again. */
  drop(): void {
    this.connected = false;
  }
  /** Network teardown that never answers — like a half-open socket. */
  hangTeardown = false;
  async logOut(): Promise<boolean> {
    this.logouts++;
    if (this.hangTeardown) await new Promise(() => {});
    return true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.hangTeardown) await new Promise(() => {});
  }
  private answer(): boolean {
    const m = this.mode();
    this.connected = m === "ok";
    this.lastError = m === "ok" ? "" : m === "revoked" ? REVOKED : NETWORK;
    return this.connected;
  }
}

function setup(initial: Mode) {
  let mode = initial;
  let gate: Promise<void> = Promise.resolve();
  const clients: StubTelegram[] = [];
  const sm = new SessionManager(":memory:", () => {
    const c = new StubTelegram(
      () => mode,
      () => gate,
    );
    clients.push(c);
    return c as unknown as TelegramService;
  });
  const db = sm.getDb();
  const oauth = new OAuthProvider({ issuer: "https://dead-session-test.invalid", db });
  sm.setOnSessionDead(createDeadSessionHandler(sm, oauth));
  sm.saveSessionString("alice", "stored-session");
  db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
    "tok-hash",
    "client",
    "alice",
    Math.floor(Date.now() / 1000) + 3600,
  );
  return {
    sm,
    clients,
    setMode: (m: Mode) => {
      mode = m;
    },
    setGate: (p: Promise<void>) => {
      gate = p;
    },
    stored: () => {
      const row = db.prepare("SELECT session_string FROM user_sessions WHERE user_id = 'alice'").get() as
        | { session_string: string }
        | undefined;
      return row ? decryptSecret(row.session_string) : undefined;
    },
    tokens: () =>
      (db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE user_id = 'alice'").get() as { n: number }).n,
  };
}

/** Lets the cleanup, scheduled outside the per-user lock, run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("dead Telegram session (cloud#42)", () => {
  it("a rejected connect drops the stored session and revokes OAuth, once under a burst", async () => {
    const t = setup("revoked");
    await Promise.all([t.sm.getOrCreateSession("alice"), t.sm.getOrCreateSession("alice")]);
    await settle();
    assert.equal(t.stored(), undefined, "stored session removed");
    assert.equal(t.tokens(), 0, "OAuth tokens revoked, so the client re-authorizes");

    // Nothing left to retry: a further request does not reach Telegram with the dead key.
    const before = t.clients.length;
    await t.sm.getOrCreateSession("alice");
    await settle();
    assert.equal(t.stored(), undefined);
    assert.equal(t.clients.length - before, 1, "one fresh client, built without a session");
  });

  it("does not touch a session that only failed on the network", async () => {
    const t = setup("network");
    await t.sm.getOrCreateSession("alice");
    await settle();
    assert.equal(t.stored(), "stored-session");
    assert.equal(t.tokens(), 1);
  });

  it("keeps the demo account behind a live review link (review rule 4)", async () => {
    const t = setup("revoked");
    t.sm.createReviewToken("alice", "OpenAI directory review", 3600);
    await t.sm.getOrCreateSession("alice");
    await settle();
    assert.equal(t.stored(), "stored-session");
    assert.equal(t.tokens(), 1, "revoking the review account's OAuth would cut every reviewer off");
  });

  it("a revoked review link no longer shields the account", async () => {
    const t = setup("revoked");
    const token = t.sm.createReviewToken("alice", "OpenAI directory review", 3600);
    assert.ok(t.sm.revokeReviewToken(token));
    await t.sm.getOrCreateSession("alice");
    await settle();
    assert.equal(t.stored(), undefined);
    assert.equal(t.tokens(), 0);
  });

  // Review finding: the cleanup runs after the lock that saw the rejection is released.
  it("spares credentials a QR login saved while the rejected connect was in flight", async () => {
    const t = setup("revoked");
    let release = () => {};
    t.setGate(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const pending = t.sm.getOrCreateSession("alice");
    await settle(); // the connect with the old key is now waiting on Telegram
    assert.equal(t.clients.length, 1);
    t.sm.saveSessionString("alice", "fresh-session"); // QR login finished meanwhile
    release();
    await pending;
    await settle();
    assert.equal(t.stored(), "fresh-session", "the new session survives");
    assert.equal(t.tokens(), 1, "and so do the user's tokens");
  });

  // Review finding: the pooled branch ignored the reconnect result, so telegram-status
  // (which skips requireConnection) kept the loop going.
  it("a pooled client whose reconnect is refused is cleaned up too", async () => {
    const t = setup("ok");
    await t.sm.getOrCreateSession("alice");
    const pooled = t.clients[0];
    assert.ok(pooled?.isConnected());
    t.setMode("revoked");
    pooled.drop();
    await t.sm.getOrCreateSession("alice");
    await settle();
    assert.equal(t.stored(), undefined);
    assert.equal(t.tokens(), 0);
  });

  // Review finding (round 2): QR login saves credentials without the per-user lock, so the
  // cleanup must not await the network between its check and the delete.
  it("deletes before any network teardown, so a QR save right after survives", async () => {
    const t = setup("ok");
    await t.sm.getOrCreateSession("alice");
    const pooled = t.clients[0];
    assert.ok(pooled);
    pooled.hangTeardown = true;
    t.sm.reportDeadSession("alice", pooled as unknown as TelegramService);
    await settle();
    assert.equal(t.stored(), undefined, "removed without waiting on a teardown that never answers");
    assert.equal(t.tokens(), 0);

    t.sm.saveSessionString("alice", "fresh-session"); // QR login finishes now
    await settle();
    assert.equal(t.stored(), "fresh-session", "nothing pending deletes it afterwards");
  });

  // Review finding (round 3): tryReconnect deleting the row first must not let the
  // cleanup skip the OAuth revocation.
  it("tryReconnect on a revoked session revokes OAuth as well", async () => {
    const t = setup("revoked");
    assert.equal(await t.sm.tryReconnectSession("alice"), null);
    await settle();
    assert.equal(t.stored(), undefined);
    assert.equal(t.tokens(), 0, "the client gets a 401 and re-authorizes");
  });

  it("a cleanup that finds the row already gone still revokes OAuth", async () => {
    const t = setup("ok");
    await t.sm.getOrCreateSession("alice");
    const pooled = t.clients[0];
    assert.ok(pooled);
    t.sm.reportDeadSession("alice", pooled as unknown as TelegramService);
    t.sm.getDb().prepare("DELETE FROM user_sessions WHERE user_id = 'alice'").run(); // removed first
    await settle();
    assert.equal(t.tokens(), 0);
  });

  // Review finding (round 3): a stale disconnectUser save can put the old string back after
  // a QR login; the adopted fresh client is what proves the user is signed in again.
  it("skips cleanup once a fresh login was adopted", async () => {
    const t = setup("ok");
    await t.sm.getOrCreateSession("alice");
    const pooled = t.clients[0];
    assert.ok(pooled);
    t.sm.reportDeadSession("alice", pooled as unknown as TelegramService);
    const fresh = new StubTelegram(
      () => "ok",
      async () => {},
    );
    fresh.setSessionString("fresh-session");
    await t.sm.adoptSession("alice", fresh as unknown as TelegramService); // queued ahead of the cleanup
    await settle();
    assert.equal(t.tokens(), 1, "the new login keeps its tokens");
    assert.equal(t.sm.getSession("alice"), fresh as unknown as TelegramService);
  });

  it("tryReconnect does not delete credentials a QR login saved during its connect", async () => {
    const t = setup("revoked");
    let release = () => {};
    t.setGate(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const pending = t.sm.tryReconnectSession("alice");
    await settle();
    t.sm.saveSessionString("alice", "fresh-session");
    release();
    assert.equal(await pending, null);
    await settle();
    assert.equal(t.stored(), "fresh-session");
    assert.equal(t.tokens(), 1);
  });

  it("a secondary account connecting during the owner's cleanup is not pooled again", async () => {
    const t = setup("ok");
    await t.sm.getOrCreateSession("alice");
    const primary = t.clients[0];
    assert.ok(primary);
    const accountId = t.sm.addAccount("alice", "tg-2", "second-session", null);
    t.sm.setActiveAccount("alice", accountId);
    let release = () => {};
    t.setGate(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const connecting = t.sm.ensureActiveSession("alice");
    await settle();
    t.sm.reportDeadSession("alice", primary as unknown as TelegramService);
    await settle();
    assert.equal(t.tokens(), 0, "owner cleaned up");
    release();
    await connecting;
    await settle();
    const secondary = t.clients[1];
    assert.ok(secondary);
    assert.equal(secondary.isConnected(), false, "the removed account's client is torn down");
  });

  // Review finding: a dead secondary account (or any client that is not the owner's pooled
  // primary) must not take the primary session down.
  it("reportDeadSession ignores a client that is not the pooled primary", async () => {
    const t = setup("ok");
    await t.sm.getOrCreateSession("alice");
    const stranger = new StubTelegram(
      () => "revoked",
      async () => {},
    );
    t.sm.reportDeadSession("alice", stranger as unknown as TelegramService);
    await settle();
    assert.equal(t.stored(), "stored-session");
    assert.equal(t.tokens(), 1);

    t.sm.reportDeadSession("alice", t.clients[0] as unknown as TelegramService);
    await settle();
    assert.equal(t.stored(), undefined, "the pooled primary itself is judged dead");
    assert.equal(t.tokens(), 0);
  });

  it("hasLiveReviewToken follows the review link's lifetime", () => {
    const t = setup("ok");
    assert.equal(t.sm.hasLiveReviewToken(), false);
    const token = t.sm.createReviewToken("alice", "OpenAI directory review", 3600);
    assert.equal(t.sm.hasLiveReviewToken(), true);
    t.sm.revokeReviewToken(token);
    assert.equal(t.sm.hasLiveReviewToken(), false);
  });
});
