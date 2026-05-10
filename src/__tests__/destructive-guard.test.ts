import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DestructiveGuard, summarizeArgs } from "../destructive-guard.js";

const SETTINGS_URL = "https://example.invalid/my/settings";

function freshDb(): Database {
  // `:memory:` keeps each test isolated — no shared SQLite file across cases.
  return new Database(":memory:");
}

describe("DestructiveGuard — schema + toggle + audit", () => {
  it("creates user_prefs and destructive_audit tables on construction (idempotent)", () => {
    const db = freshDb();
    new DestructiveGuard(db, 20, SETTINGS_URL);
    // Second instance must not throw (CREATE IF NOT EXISTS).
    new DestructiveGuard(db, 20, SETTINGS_URL);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("user_prefs"), "user_prefs table missing");
    assert.ok(names.includes("destructive_audit"), "destructive_audit table missing");
  });

  it("isEnabled defaults to false for an unknown user", () => {
    const guard = new DestructiveGuard(freshDb(), 20, SETTINGS_URL);
    assert.equal(guard.isEnabled("alice"), false);
  });

  it("setEnabled persists and toggles", () => {
    const guard = new DestructiveGuard(freshDb(), 20, SETTINGS_URL);
    guard.setEnabled("alice", true);
    assert.equal(guard.isEnabled("alice"), true);
    guard.setEnabled("alice", false);
    assert.equal(guard.isEnabled("alice"), false);
  });

  it("preflight denies when toggle is off and writes a denied_disabled audit row", () => {
    const guard = new DestructiveGuard(freshDb(), 20, SETTINGS_URL);
    const err = guard.preflight("alice", "telegram-delete-message", "chatId=test ids[3]");
    assert.ok(err?.includes("disabled"), `expected denial error, got: ${err}`);
    const rows = guard.listForUser("alice");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "denied_disabled");
    assert.equal(rows[0].tool_name, "telegram-delete-message");
    assert.match(rows[0].args_summary, /chatId=test/);
  });

  it("preflight allows when toggle is on; recordResult writes an ok row", () => {
    const guard = new DestructiveGuard(freshDb(), 20, SETTINGS_URL);
    guard.setEnabled("alice", true);
    const err = guard.preflight("alice", "telegram-delete-message", "chatId=x ids[1]");
    assert.equal(err, null);
    guard.recordResult("alice", "telegram-delete-message", "chatId=x ids[1]", "ok");
    const rows = guard.listForUser("alice");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "ok");
  });

  it("daily quota counts only successful (`ok`) calls, not denials or errors", () => {
    const guard = new DestructiveGuard(freshDb(), 2, SETTINGS_URL);
    guard.setEnabled("alice", true);

    // Two successes — fills quota.
    assert.equal(guard.preflight("alice", "telegram-delete-message", "a"), null);
    guard.recordResult("alice", "telegram-delete-message", "a", "ok");
    assert.equal(guard.preflight("alice", "telegram-delete-message", "b"), null);
    guard.recordResult("alice", "telegram-delete-message", "b", "ok");

    // Third attempt is denied by quota.
    const err = guard.preflight("alice", "telegram-delete-message", "c");
    assert.ok(err?.includes("Daily destructive-action limit"), `expected quota error, got: ${err}`);

    // Same-day error rows must not consume quota — but here we're already over,
    // so check that the audit log has 4 rows: 2 ok + 1 denied_quota + 0 errors yet.
    let rows = guard.listForUser("alice");
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.result === "ok").length, 2);
    assert.equal(rows.filter((r) => r.result === "denied_quota").length, 1);

    // An error row is recorded as 'error' but doesn't move the quota counter.
    guard.recordResult("alice", "telegram-delete-message", "d", "error");
    rows = guard.listForUser("alice");
    assert.equal(rows.length, 4);
    assert.equal(guard.todayOkCount("alice"), 2);
  });

  it("dailyLimit=0 disables the quota check entirely", () => {
    const guard = new DestructiveGuard(freshDb(), 0, SETTINGS_URL);
    guard.setEnabled("alice", true);
    for (let i = 0; i < 5; i++) {
      assert.equal(guard.preflight("alice", "telegram-delete-message", `i=${i}`), null);
      guard.recordResult("alice", "telegram-delete-message", `i=${i}`, "ok");
    }
    assert.equal(guard.todayOkCount("alice"), 5);
  });

  it("listForUser returns newest-first and respects the limit", () => {
    const guard = new DestructiveGuard(freshDb(), 100, SETTINGS_URL);
    guard.setEnabled("alice", true);
    for (let i = 0; i < 10; i++) {
      guard.recordResult("alice", "telegram-delete-message", `i=${i}`, "ok");
    }
    const rows = guard.listForUser("alice", 3);
    assert.equal(rows.length, 3);
    // Newest first — id descending.
    assert.ok(rows[0].id > rows[1].id);
    assert.ok(rows[1].id > rows[2].id);
  });

  it("preflight error message includes the settings URL so users know where to enable", () => {
    const guard = new DestructiveGuard(freshDb(), 20, SETTINGS_URL);
    const err = guard.preflight("bob", "telegram-delete-stories", "");
    assert.ok(err);
    assert.ok(err.includes(SETTINGS_URL), `error must contain settings URL, got: ${err}`);
  });
});

describe("summarizeArgs", () => {
  it("returns empty for non-objects", () => {
    assert.equal(summarizeArgs(undefined), "");
    assert.equal(summarizeArgs(null), "");
    assert.equal(summarizeArgs("string"), "");
    assert.equal(summarizeArgs(42), "");
  });

  it("renders scalar fields and arrays as count", () => {
    const out = summarizeArgs({ chatId: "@foo", messageIds: [1, 2, 3], confirm: true });
    assert.match(out, /chatId=@foo/);
    assert.match(out, /messageIds\[3\]/);
    assert.match(out, /confirm=true/);
  });

  it("truncates long strings to 24 chars with ellipsis", () => {
    const out = summarizeArgs({ chatId: "x".repeat(50) });
    assert.match(out, /chatId=x{24}…/);
  });

  it("skips undefined and null values", () => {
    const out = summarizeArgs({ chatId: "@foo", maybe: undefined, also: null });
    assert.match(out, /chatId=@foo/);
    assert.ok(!out.includes("maybe"));
    assert.ok(!out.includes("also"));
  });

  it("caps total length to prevent log bloat", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) obj[`field_${i}`] = `value_${i}`;
    const out = summarizeArgs(obj);
    assert.ok(out.length <= 201, `expected truncation, got length ${out.length}`); // 200 + ellipsis char
    assert.ok(out.endsWith("…"), "expected ellipsis suffix");
  });
});
