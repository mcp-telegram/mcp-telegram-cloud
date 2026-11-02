/**
 * Username reuse takeover (security audit 2026-11-02).
 *
 * `user_sessions` is keyed by the public username, and Telegram lets an owner give a
 * username up and anyone else claim it. Before `resolveAccountKey`, the new holder of a
 * released username who scanned the QR code:
 * - on /login/qr got a browser session for the PREVIOUS owner's row (the "already
 *   connected" branch reconnected the stored session), then consent + token = full
 *   access to the previous owner's Telegram;
 * - on /oauth/authorize/qr overwrote the previous owner's row, after which the previous
 *   owner's live tokens drove the new account.
 *
 * Driven through a real SessionManager on an in-memory database with a Telegram double
 * whose identity depends on the stored session string, so every case asserts the key a
 * scan resolves to and what the database records.
 */
process.env.ISSUER ??= "https://account-key-test.invalid";
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

/** Session string → numeric Telegram id of the account it belongs to. */
type Directory = Map<string, number>;
type Mode = "ok" | "revoked" | "network";

const REVOKED = "Session revoked. Run telegram-login to re-authenticate.";
const NETWORK = "Network error: TIMEOUT. Run telegram-status to retry connection.";

class StubTelegram {
  lastError = "";
  private connected = false;
  private session = "";
  constructor(
    private readonly directory: Directory,
    private readonly mode: () => Mode,
  ) {}
  setSessionString(s: string): void {
    this.session = s;
  }
  getSessionString(): string {
    return this.session;
  }
  async connect(): Promise<boolean> {
    const m = this.mode();
    if (m === "ok") {
      this.connected = true;
      return true;
    }
    this.lastError = m === "revoked" ? REVOKED : NETWORK;
    return false;
  }
  async ensureConnected(): Promise<boolean> {
    return this.connected;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async getMe(): Promise<{ id: number; username?: string }> {
    const id = this.directory.get(this.session);
    if (id === undefined) throw new Error("unknown session");
    return { id };
  }
  async logOut(): Promise<boolean> {
    return true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

const VICTIM_ID = 1001;
const ATTACKER_ID = 2002;

function setup(mode: Mode = "ok") {
  const directory: Directory = new Map([
    ["victim-session", VICTIM_ID],
    ["attacker-session", ATTACKER_ID],
  ]);
  let current = mode;
  const sm = new SessionManager(
    ":memory:",
    () => new StubTelegram(directory, () => current) as unknown as TelegramService,
  );
  const db = sm.getDb();
  const telegramIdOf = (userId: string) =>
    (
      db.prepare("SELECT telegram_id FROM user_sessions WHERE user_id = ?").get(userId) as
        | { telegram_id: string | null }
        | undefined
    )?.telegram_id;
  return {
    sm,
    db,
    telegramIdOf,
    setMode: (m: Mode) => {
      current = m;
    },
  };
}

describe("resolveAccountKey: a released username never hands over the previous owner's row", () => {
  it("pinned row: the new holder of the username gets their own numeric key", async () => {
    const { sm, telegramIdOf } = setup();
    sm.saveSessionString("alice", "victim-session", String(VICTIM_ID));

    // Victim renamed to alice2, attacker claimed "alice" and scanned.
    const key = await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID });

    assert.equal(key, String(ATTACKER_ID));
    assert.equal(telegramIdOf("alice"), String(VICTIM_ID), "the victim's row is untouched");
  });

  it("legacy row without an id: verified through the stored session, then left alone", async () => {
    const { sm, telegramIdOf } = setup();
    sm.saveSessionString("alice", "victim-session"); // pre-fix row, owner unknown
    assert.equal(telegramIdOf("alice"), null);

    const key = await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID });

    assert.equal(key, String(ATTACKER_ID));
    assert.equal(telegramIdOf("alice"), String(VICTIM_ID), "the check records who the row belongs to");
  });

  it("the previous owner keeps their row after renaming", async () => {
    const { sm } = setup();
    sm.saveSessionString("alice", "victim-session", String(VICTIM_ID));

    assert.equal(await sm.resolveAccountKey({ username: "alice2", id: VICTIM_ID }), "alice");
  });

  it("the owner signing in again resolves to their own row", async () => {
    const { sm } = setup();
    sm.saveSessionString("alice", "victim-session");

    assert.equal(await sm.resolveAccountKey({ username: "alice", id: VICTIM_ID }), "alice");
    // and from now on without touching Telegram
    assert.equal(await sm.resolveAccountKey({ username: "alice", id: VICTIM_ID }), "alice");
  });

  it("a free username is used as is; an account without one uses its numeric id", async () => {
    const { sm } = setup();
    assert.equal(await sm.resolveAccountKey({ username: "bob", id: ATTACKER_ID }), "bob");
    assert.equal(await sm.resolveAccountKey({ username: null, id: ATTACKER_ID }), String(ATTACKER_ID));
  });

  it("a revoked legacy row does not hand its key over: its owner stays unknown", async () => {
    // Review finding: tokens, review links and secondary accounts can outlive the row, so
    // giving the username key to the next scanner would give them those too.
    const { sm, setMode } = setup();
    sm.saveSessionString("alice", "victim-session");
    sm.addAccount("alice", "victim-work", "victim-work-session", null);
    setMode("revoked");

    assert.equal(await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID }), String(ATTACKER_ID));
    assert.deepEqual(sm.getSavedUserIds(), [], "Telegram refused the stored session, so the row is gone");
    assert.deepEqual(
      sm.listAccounts(String(ATTACKER_ID)).filter((a) => a.accountId > 0),
      [],
      "none of alice's secondary accounts",
    );
  });

  it("an unreachable legacy row is not guessed: the caller asks to retry", async () => {
    const { sm, telegramIdOf, setMode } = setup();
    sm.saveSessionString("alice", "victim-session");
    setMode("network");

    assert.equal(await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID }), null);
    assert.equal(telegramIdOf("alice"), null);
    assert.deepEqual(sm.getSavedUserIds(), ["alice"], "a network error never deletes the row");
  });
});

describe("a username whose row is gone but whose access lingers is not reused (review round 2)", () => {
  it("secondary accounts left under the key keep it reserved across repeated sign-ins", async () => {
    // Revoked legacy row with secondary accounts (a review account skips cleanup). The new
    // holder of the username gets a numeric key, revokes it (row gone), signs in again: the
    // username must still not resolve to the old key.
    const { sm, db, setMode } = setup();
    sm.saveSessionString("alice", "victim-session");
    sm.addAccount("alice", "victim-work", "victim-work-session", null);
    setMode("revoked");
    assert.equal(await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID }), String(ATTACKER_ID));

    db.prepare("DELETE FROM user_sessions").run();
    setMode("ok");
    assert.equal(await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID }), String(ATTACKER_ID));
  });

  it("live OAuth tokens or a review link under the key also reserve it", async () => {
    const { OAuthProvider } = await import("../oauth.js");
    const { sm, db } = setup();
    new OAuthProvider({ issuer: "https://account-key-test.invalid", db });
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      "h1:x",
      "c",
      "alice",
      future,
    );
    assert.equal(await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID }), String(ATTACKER_ID));

    db.prepare("DELETE FROM oauth_tokens").run();
    db.prepare("INSERT INTO review_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
      "h",
      "alice",
      future,
    );
    assert.equal(await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID }), String(ATTACKER_ID));

    // A browser handoff minted for the old key (review round 3) would sign its holder in.
    db.prepare("DELETE FROM review_tokens").run();
    db.prepare("INSERT INTO browser_handoffs (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
      "hh",
      "alice",
      future,
    );
    assert.equal(await sm.resolveAccountKey({ username: "alice", id: ATTACKER_ID }), String(ATTACKER_ID));
  });

  it("a cleanly disconnected user gets their username back", async () => {
    const { OAuthProvider } = await import("../oauth.js");
    const { sm, db } = setup();
    const oauth = new OAuthProvider({ issuer: "https://account-key-test.invalid", db });
    // History and settings do not reserve the key.
    db.prepare("INSERT INTO oauth_grants (user_id, redirect_origin) VALUES (?, ?)").run("alice", "https://claude.ai");
    oauth.revokeAllUserTokens("alice");
    assert.equal(await sm.resolveAccountKey({ username: "alice", id: VICTIM_ID }), "alice");
  });
});

describe("saveSessionString keeps the recorded owner", () => {
  it("re-saving the same account's session (disconnect) keeps telegram_id", () => {
    const { sm, telegramIdOf } = setup();
    sm.saveSessionString("alice", "victim-session", String(VICTIM_ID));
    sm.saveSessionString("alice", "victim-session-refreshed");
    assert.equal(telegramIdOf("alice"), String(VICTIM_ID));
  });

  it("an imported session clears it, so the next QR login verifies the owner again", () => {
    const { sm, telegramIdOf } = setup();
    sm.saveSessionString("alice", "victim-session", String(VICTIM_ID));
    sm.saveSessionString("alice", "attacker-session", null);
    assert.equal(telegramIdOf("alice"), null);
  });

  it("one Telegram account cannot be pinned to two rows", () => {
    const { sm } = setup();
    sm.saveSessionString("alice", "victim-session", String(VICTIM_ID));
    assert.throws(() => sm.saveSessionString("other", "victim-session", String(VICTIM_ID)));
  });
});
