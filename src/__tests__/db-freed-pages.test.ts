/**
 * Freed pages (security audit 2026-11-02).
 *
 * Without `secure_delete`, SQLite leaves deleted and overwritten rows in free pages, so a
 * session string that was later encrypted, or a removed account, stayed readable in a
 * snapshot of the database file. The test writes a recognisable marker, replaces it and
 * reads the raw file bytes.
 */
process.env.ISSUER ??= "https://freed-pages-test.invalid";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};

const MARKER = "PLAINTEXT-SESSION-MARKER-5d1c0a";

function fileBytes(path: string): string {
  let out = readFileSync(path).toString("latin1");
  try {
    out += readFileSync(`${path}-wal`).toString("latin1");
  } catch {
    // no WAL file
  }
  return out;
}

describe("freed database pages do not keep old session strings", () => {
  it("an overwritten and a deleted row leave no trace in the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "freed-pages-"));
    try {
      const path = join(dir, "cloud.db");
      const sm = new SessionManager(path, () => ({}) as unknown as TelegramService);
      const db = sm.getDb();
      // Raw writes on purpose: the stored form is what a snapshot would show.
      db.prepare("INSERT INTO user_sessions (user_id, session_string) VALUES (?, ?)").run("alice", MARKER.repeat(40));
      db.prepare("INSERT INTO user_sessions (user_id, session_string) VALUES (?, ?)").run("bob", MARKER.repeat(40));
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.prepare("UPDATE user_sessions SET session_string = ? WHERE user_id = ?").run("v1:replaced", "alice");
      db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run("bob");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      assert.ok(!fileBytes(path).includes(MARKER), "old plaintext must not survive in free pages");
      sm.getDb().close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compactOnce clears traces left before secure_delete was enabled", async () => {
    const { Database } = await import("bun:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "freed-pages-"));
    try {
      const path = join(dir, "cloud.db");
      // The database as it was before this change: secure_delete off.
      const old = new Database(path);
      old.exec("PRAGMA journal_mode = WAL");
      old.exec("PRAGMA secure_delete = OFF");
      old.exec("CREATE TABLE user_sessions (user_id TEXT PRIMARY KEY, session_string TEXT NOT NULL)");
      old.prepare("INSERT INTO user_sessions VALUES (?, ?)").run("bob", MARKER.repeat(40));
      old.prepare("DELETE FROM user_sessions WHERE user_id = ?").run("bob");
      old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      old.close();
      assert.ok(fileBytes(path).includes(MARKER), "precondition: the old file still carries the trace");

      const sm = new SessionManager(path, () => ({}) as unknown as TelegramService);
      assert.equal(sm.compactOnce("m"), true);
      assert.ok(!fileBytes(path).includes(MARKER), "compaction must remove it");
      sm.getDb().close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a busy checkpoint does not record the marker, so it runs again", async () => {
    const { Database } = await import("bun:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "freed-pages-"));
    try {
      const path = join(dir, "cloud.db");
      const sm = new SessionManager(path, () => ({}) as unknown as TelegramService);
      sm.saveSessionString("alice", "s");
      // Another connection in the middle of a read transaction, like a draining container.
      const reader = new Database(path);
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM user_sessions").get();
      sm.saveSessionString("alice", "s2");
      assert.throws(() => sm.compactOnce("m"), /checkpoint busy/);
      assert.equal(sm.getDb().prepare("SELECT 1 FROM maintenance_runs WHERE name = 'm'").get(), null);
      reader.exec("COMMIT");
      reader.close();
      assert.equal(sm.compactOnce("m"), true, "retried once the reader is gone");
      sm.getDb().close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compactOnce runs once per marker", () => {
    const sm = new SessionManager(":memory:", () => ({}) as unknown as TelegramService);
    assert.equal(sm.compactOnce("m1"), true);
    assert.equal(sm.compactOnce("m1"), false);
    assert.equal(sm.compactOnce("m2"), true);
  });
});
