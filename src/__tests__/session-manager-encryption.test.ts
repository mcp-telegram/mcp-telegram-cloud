/**
 * At-rest encryption integration with SessionManager (phase 1).
 *
 * Verifies the full contract that protects a stolen cloud.db:
 *   - saveSessionString / addAccount write a `v1:` envelope, never plaintext
 *   - the round-trip is transparent: what GramJS gets back via the read paths equals
 *     what was stored (asserted by re-reading the raw row and decrypting)
 *   - migratePlaintextSessions() upgrades legacy plaintext rows (both tables) in place,
 *     is idempotent, and re-encrypts nothing already encrypted
 *
 * Mirrors the dynamic-import + env-before-import pattern of session-manager-accounts.test.ts:
 * crypto.ts resolves its key once at module load, so SESSION_ENCRYPTION_KEY must be set
 * before the first import of ../session-manager (which imports ../crypto).
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64"); // 32 bytes → base64

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { decryptSecret, isEncrypted } = await import("../crypto.js");

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

function rawUserSession(sm: SessionManagerType, userId: string): string | undefined {
  const row = sm.getDb().prepare("SELECT session_string FROM user_sessions WHERE user_id = ?").get(userId) as
    | { session_string: string }
    | undefined;
  return row?.session_string;
}

describe("SessionManager at-rest encryption", () => {
  it("saveSessionString stores a v1: envelope, not plaintext", () => {
    const sm = makeManager();
    const secret = "1ApWfakeGramJsSessionString==";
    sm.saveSessionString("alex", secret);

    const stored = rawUserSession(sm, "alex");
    assert.ok(stored, "row should exist");
    assert.equal(isEncrypted(stored as string), true, "stored value must be encrypted");
    assert.notEqual(stored, secret, "plaintext must never hit disk");
    assert.equal(decryptSecret(stored as string), secret, "round-trips back to the original");
  });

  it("addAccount stores secondary session_string encrypted", () => {
    const sm = makeManager();
    const secret = "secondary-session==";
    const id = sm.addAccount("alex", "lizzy", secret, "Lizzy");
    const row = sm.getDb().prepare("SELECT session_string FROM telegram_accounts WHERE account_id = ?").get(id) as {
      session_string: string;
    };
    assert.equal(isEncrypted(row.session_string), true);
    assert.equal(decryptSecret(row.session_string), secret);
  });

  it("migratePlaintextSessions upgrades legacy plaintext rows in both tables", () => {
    const sm = makeManager();
    const db = sm.getDb();
    // Simulate pre-encryption rows by writing plaintext DIRECTLY (bypassing the encrypting setters).
    db.prepare("INSERT INTO user_sessions (user_id, session_string) VALUES (?, ?)").run("legacy1", "plain-primary");
    db.prepare(
      "INSERT INTO telegram_accounts (owner_user_id, telegram_user_id, session_string, label) VALUES (?, ?, ?, ?)",
    ).run("legacy1", "tg2", "plain-secondary", null);

    const migrated = sm.migratePlaintextSessions();
    assert.equal(migrated, 2, "both legacy rows migrated");

    const u = rawUserSession(sm, "legacy1") as string;
    assert.equal(isEncrypted(u), true);
    assert.equal(decryptSecret(u), "plain-primary");

    const a = db.prepare("SELECT session_string FROM telegram_accounts WHERE owner_user_id = ?").get("legacy1") as {
      session_string: string;
    };
    assert.equal(isEncrypted(a.session_string), true);
    assert.equal(decryptSecret(a.session_string), "plain-secondary");
  });

  it("migratePlaintextSessions is idempotent — already-encrypted rows untouched", () => {
    const sm = makeManager();
    sm.saveSessionString("alex", "already-secret"); // encrypted on write
    const before = rawUserSession(sm, "alex");

    const migrated = sm.migratePlaintextSessions();
    assert.equal(migrated, 0, "nothing left to migrate");
    assert.equal(rawUserSession(sm, "alex"), before, "ciphertext byte-for-byte unchanged");
  });
});
