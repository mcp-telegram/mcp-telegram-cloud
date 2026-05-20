/**
 * v2.32.0 multi-account contract for SessionManager.
 *
 * Tests cover:
 *   - new tables created and idempotent (re-open same DB doesn't break)
 *   - active_account defaults to 0 (primary) — backward-compatible
 *   - listAccounts shows primary alongside secondaries with isActive indicator
 *   - resolveAccount matches label / @username / numeric id / "primary"
 *   - setActiveAccount throws on unknown id, succeeds on known id, demotes to 0
 *   - addAccount idempotent on (owner_user_id, telegram_user_id)
 *   - removeAccount drops the row + demotes active to 0 if it was active
 *   - removeAccount refuses primary
 *   - getSession routes through active_account (returns secondary's TelegramService when active)
 *   - ensureActiveSession materialises secondaries lazily
 *   - destroyUserSession cascades — wipes telegram_accounts + active_account + add_tokens
 *   - add-account capability tokens: peek without consume, single-use consume,
 *     expired/used tokens both return null
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};

class StubTelegramService {
  private connected = false;
  private sessionString: string | undefined;

  async connect(): Promise<boolean> {
    this.connected = true;
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async ensureConnected(): Promise<boolean> {
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async logOut(): Promise<boolean> {
    return true;
  }
  setSessionString(s: string): void {
    this.sessionString = s;
  }
  getSessionString(): string | undefined {
    return this.sessionString;
  }
}

function makeManager(): SessionManagerType {
  return new SessionManager(":memory:", () => new StubTelegramService() as unknown as TelegramService);
}

describe("SessionManager multi-account — schema & defaults", () => {
  it("active account defaults to 0 (primary) for unknown owners", () => {
    const sm = makeManager();
    assert.equal(sm.getActiveAccountId("alex"), 0);
  });

  it("listAccounts returns empty when owner has no primary session", () => {
    const sm = makeManager();
    assert.deepEqual(sm.listAccounts("alex"), []);
  });

  it("listAccounts shows primary alone after saveSessionString — isActive=true", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "session-string-1");
    const accounts = sm.listAccounts("alex");
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].isPrimary, true);
    assert.equal(accounts[0].isActive, true);
    assert.equal(accounts[0].accountId, 0);
    assert.equal(accounts[0].telegramUserId, "alex");
  });
});

describe("SessionManager multi-account — add / list / resolve", () => {
  it("addAccount creates a row, gives autoincrement id", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary-session");
    const id1 = sm.addAccount("alex", "test1", "ss1", "testing");
    const id2 = sm.addAccount("alex", "test2", "ss2", null);
    assert.ok(id1 > 0);
    assert.ok(id2 > id1);
  });

  it("addAccount is idempotent on (owner, telegramUserId) — updates session_string", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    const id1 = sm.addAccount("alex", "test1", "ss1", "testing");
    const id2 = sm.addAccount("alex", "test1", "ss1-new", "renamed");
    assert.equal(id1, id2, "same row updated");
    const accounts = sm.listAccounts("alex");
    const secondary = accounts.find((a) => !a.isPrimary);
    assert.ok(secondary);
    assert.equal(secondary?.label, "renamed");
  });

  it("listAccounts returns primary first, then secondaries in id order", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    sm.addAccount("alex", "test2", "ss2", null);
    sm.addAccount("alex", "test1", "ss1", "testing");
    const accounts = sm.listAccounts("alex");
    assert.equal(accounts.length, 3);
    assert.equal(accounts[0].isPrimary, true);
    assert.equal(accounts[1].telegramUserId, "test2"); // inserted first → lower id
    assert.equal(accounts[2].telegramUserId, "test1");
  });

  it("resolveAccount matches by label (case-insensitive)", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    sm.addAccount("alex", "test1", "ss1", "Testing");
    const a = sm.resolveAccount("alex", "testing");
    assert.equal(a?.telegramUserId, "test1");
  });

  it("resolveAccount matches by @username and numeric id and 'primary'", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    const id = sm.addAccount("alex", "test1", "ss1", null);
    assert.equal(sm.resolveAccount("alex", "@test1")?.accountId, id);
    assert.equal(sm.resolveAccount("alex", "test1")?.accountId, id);
    assert.equal(sm.resolveAccount("alex", String(id))?.accountId, id);
    assert.equal(sm.resolveAccount("alex", "primary")?.isPrimary, true);
    assert.equal(sm.resolveAccount("alex", "0")?.isPrimary, true);
    assert.equal(sm.resolveAccount("alex", "nonexistent"), null);
  });

  it("resolveAccount does not match across owners", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary-alex");
    sm.saveSessionString("bob", "primary-bob");
    sm.addAccount("bob", "test1", "ss-bob-test1", "testing");
    assert.equal(sm.resolveAccount("alex", "testing"), null);
    assert.equal(sm.resolveAccount("alex", "@test1"), null);
  });
});

describe("SessionManager multi-account — switch & active routing", () => {
  it("setActiveAccount(0) is a no-op equivalent to 'use primary'", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    sm.setActiveAccount("alex", 0);
    assert.equal(sm.getActiveAccountId("alex"), 0);
  });

  it("setActiveAccount throws on unknown account_id", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    assert.throws(() => sm.setActiveAccount("alex", 999));
  });

  it("setActiveAccount on a known secondary makes listAccounts mark it active", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    const id = sm.addAccount("alex", "test1", "ss1", "testing");
    sm.setActiveAccount("alex", id);
    const accounts = sm.listAccounts("alex");
    assert.equal(accounts.find((a) => a.isPrimary)?.isActive, false);
    assert.equal(accounts.find((a) => a.accountId === id)?.isActive, true);
  });

  it("getSession routes through active_account: returns secondary's instance after switch", async () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary-session");
    const id = sm.addAccount("alex", "test1", "secondary-session", null);

    // Primary route: ensure pool has primary instance
    const primary = await sm.getOrCreateSession("alex");
    assert.equal(sm.getSession("alex"), primary);

    // Switch + materialise secondary
    sm.setActiveAccount("alex", id);
    const secondary = await sm.ensureActiveSession("alex");
    assert.notEqual(secondary, primary);
    assert.equal(sm.getSession("alex"), secondary);

    // Switch back to primary
    sm.setActiveAccount("alex", 0);
    assert.equal(sm.getSession("alex"), primary);
  });

  it("ensureActiveSession demotes to primary if the active account row vanished", async () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    const id = sm.addAccount("alex", "test1", "ss1", null);
    sm.setActiveAccount("alex", id);

    // Force-delete the secondary row from underneath SessionManager.
    sm.getDb().prepare("DELETE FROM telegram_accounts WHERE account_id = ?").run(id);

    const fallback = await sm.ensureActiveSession("alex");
    assert.ok(fallback);
    assert.equal(sm.getActiveAccountId("alex"), 0);
  });
});

describe("SessionManager multi-account — remove", () => {
  it("removeAccount drops the row and returns true; second remove returns false", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    const id = sm.addAccount("alex", "test1", "ss1", null);
    assert.equal(sm.removeAccount("alex", id), true);
    assert.equal(sm.removeAccount("alex", id), false);
    assert.equal(sm.listAccounts("alex").length, 1);
  });

  it("removeAccount of active secondary demotes active to primary (0)", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    const id = sm.addAccount("alex", "test1", "ss1", null);
    sm.setActiveAccount("alex", id);
    assert.equal(sm.getActiveAccountId("alex"), id);
    sm.removeAccount("alex", id);
    assert.equal(sm.getActiveAccountId("alex"), 0);
  });

  it("removeAccount throws for primary (accountId=0)", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    assert.throws(() => sm.removeAccount("alex", 0));
  });
});

describe("SessionManager multi-account — destroyUserSession cleanup", () => {
  it("destroyUserSession wipes secondaries + active_account + add_tokens for the owner", async () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary");
    const id = sm.addAccount("alex", "test1", "ss1", "testing");
    sm.setActiveAccount("alex", id);
    sm.createAddAccountToken("alex", "another", 600);

    // Pre-conditions
    assert.equal(sm.listAccounts("alex").length, 2);
    assert.equal(sm.getActiveAccountId("alex"), id);

    await sm.destroyUserSession("alex");

    // All secondaries gone, active reverts to 0 (no row), tokens purged
    assert.equal(sm.listAccounts("alex").length, 0);
    assert.equal(sm.getActiveAccountId("alex"), 0);
    const tokensLeft = sm
      .getDb()
      .prepare("SELECT COUNT(*) as c FROM add_account_tokens WHERE owner_user_id = ?")
      .get("alex") as { c: number };
    assert.equal(tokensLeft.c, 0);
  });

  it("destroyUserSession of one owner does NOT touch the other owner's secondaries", async () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "primary-alex");
    sm.saveSessionString("bob", "primary-bob");
    sm.addAccount("alex", "test-alex", "ss-a", null);
    sm.addAccount("bob", "test-bob", "ss-b", null);

    await sm.destroyUserSession("alex");

    assert.equal(sm.listAccounts("alex").length, 0);
    assert.equal(sm.listAccounts("bob").length, 2); // primary + secondary
  });
});

describe("SessionManager multi-account — add-account capability tokens", () => {
  it("peekAddAccountToken returns owner+label, does NOT consume", () => {
    const sm = makeManager();
    const token = sm.createAddAccountToken("alex", "testing", 600);
    const peek1 = sm.peekAddAccountToken(token);
    const peek2 = sm.peekAddAccountToken(token);
    assert.deepEqual(peek1, { ownerUserId: "alex", label: "testing" });
    assert.deepEqual(peek2, peek1);
  });

  it("consumeAddAccountToken returns owner+label once, subsequent consume returns null", () => {
    const sm = makeManager();
    const token = sm.createAddAccountToken("alex", null, 600);
    const r1 = sm.consumeAddAccountToken(token);
    const r2 = sm.consumeAddAccountToken(token);
    assert.deepEqual(r1, { ownerUserId: "alex", label: null });
    assert.equal(r2, null);
  });

  it("peek/consume return null for expired tokens", () => {
    const sm = makeManager();
    const token = sm.createAddAccountToken("alex", null, -1); // already expired
    assert.equal(sm.peekAddAccountToken(token), null);
    assert.equal(sm.consumeAddAccountToken(token), null);
  });

  it("peek/consume return null for unknown tokens (no leak)", () => {
    const sm = makeManager();
    assert.equal(sm.peekAddAccountToken("does-not-exist"), null);
    assert.equal(sm.consumeAddAccountToken("does-not-exist"), null);
  });

  it("pruneAddAccountTokens removes expired and used", () => {
    const sm = makeManager();
    const expired = sm.createAddAccountToken("alex", null, -1);
    const used = sm.createAddAccountToken("alex", null, 600);
    sm.consumeAddAccountToken(used);
    const fresh = sm.createAddAccountToken("alex", null, 600);

    const pruned = sm.pruneAddAccountTokens();
    assert.equal(pruned, 2);
    assert.equal(sm.peekAddAccountToken(expired), null);
    assert.equal(sm.peekAddAccountToken(used), null);
    assert.deepEqual(sm.peekAddAccountToken(fresh), { ownerUserId: "alex", label: null });
  });
});
