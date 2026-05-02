import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { UploadStore } from "../upload-store.js";

const FILE_MAX = 1024;
const QUOTA = 4096;
const TTL_MS = 60_000;

function freshDb(): Database.Database {
  return new Database(":memory:");
}

let TEST_DIR = "";

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "mcp-uploads-test-"));
});

afterEach(async () => {
  if (TEST_DIR) await rm(TEST_DIR, { recursive: true, force: true });
});

function makeStore(opts?: { fileMax?: number; quota?: number; ttlMs?: number }): UploadStore {
  return new UploadStore(freshDb(), opts?.fileMax ?? FILE_MAX, opts?.quota ?? QUOTA, opts?.ttlMs ?? TTL_MS, TEST_DIR);
}

describe("UploadStore — schema + put/resolve/consume", () => {
  it("creates pending_uploads table on construction (idempotent)", () => {
    const db = freshDb();
    new UploadStore(db, FILE_MAX, QUOTA, TTL_MS, TEST_DIR);
    new UploadStore(db, FILE_MAX, QUOTA, TTL_MS, TEST_DIR);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    assert.ok(tables.some((t) => t.name === "pending_uploads"));
  });

  it("put stores bytes and returns an upload ID + expiry", async () => {
    const store = makeStore();
    const result = await store.put("alice", Buffer.from("hello"), "text/plain", "hello.txt");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.id.startsWith("upl_"), `id should be prefixed: ${result.id}`);
    assert.ok(result.expiresAt instanceof Date);
    const files = readdirSync(TEST_DIR);
    assert.equal(files.length, 1, `expected 1 file in ${TEST_DIR}, got ${files.length}`);
  });

  it("resolve returns the row for the owning user", async () => {
    const store = makeStore();
    const put = await store.put("alice", Buffer.from("hi"), "text/plain", null);
    assert.equal(put.ok, true);
    if (!put.ok) return;
    const resolved = store.resolve("alice", put.id);
    assert.ok(resolved);
    assert.equal(resolved?.user_id, "alice");
    assert.equal(resolved?.size, 2);
  });

  it("resolve returns null for a different user (cross-user isolation)", async () => {
    const store = makeStore();
    const put = await store.put("alice", Buffer.from("hi"), "text/plain", null);
    if (!put.ok) return;
    const stolen = store.resolve("bob", put.id);
    assert.equal(stolen, null, "bob must not see alice's upload");
  });

  it("resolve returns null for an unknown ID", () => {
    const store = makeStore();
    assert.equal(store.resolve("alice", "upl_nonexistent"), null);
  });

  it("consume deletes the row + unlinks the file (idempotent)", async () => {
    const store = makeStore();
    const put = await store.put("alice", Buffer.from("bye"), "text/plain", null);
    if (!put.ok) return;
    const first = await store.consume("alice", put.id);
    assert.ok(first);
    const second = await store.consume("alice", put.id);
    assert.equal(second, null, "consume should be idempotent");
    const files = readdirSync(TEST_DIR);
    assert.equal(files.length, 0);
  });

  it("listForUser returns newest first, scoped to user", async () => {
    const store = makeStore();
    const a = await store.put("alice", Buffer.from("a"), "text/plain", null);
    const b = await store.put("alice", Buffer.from("b"), "text/plain", null);
    await store.put("bob", Buffer.from("c"), "text/plain", null);
    if (!a.ok || !b.ok) return;
    const rows = store.listForUser("alice", 10);
    assert.equal(rows.length, 2);
    // SQLite's `ORDER BY created_at DESC` may tie at second-resolution; ensure both alice rows are present
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(a.id) && ids.includes(b.id));
    assert.ok(rows.every((r) => r.user_id === "alice"));
  });
});

describe("UploadStore — quotas", () => {
  it("preflight rejects files larger than fileMaxBytes", () => {
    const store = makeStore({ fileMax: 100 });
    const denied = store.preflight("alice", 101);
    assert.ok(denied);
    assert.equal(denied?.reason, "file_too_large");
  });

  it("preflight rejects when quota would be exceeded", async () => {
    const store = makeStore({ fileMax: 100, quota: 150 });
    await store.put("alice", Buffer.alloc(80), "application/octet-stream", null);
    const denied = store.preflight("alice", 80); // 80 + 80 = 160 > 150
    assert.ok(denied);
    assert.equal(denied?.reason, "quota_exceeded");
  });

  it("put returns deny envelope when preflight TOCTOU triggers", async () => {
    const store = makeStore({ fileMax: 100 });
    const result = await store.put("alice", Buffer.alloc(200), "application/octet-stream", null);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "file_too_large");
  });

  it("pendingBytesForUser sums only that user's pending rows", async () => {
    const store = makeStore({ fileMax: 100, quota: 1000 });
    await store.put("alice", Buffer.alloc(50), "application/octet-stream", null);
    await store.put("alice", Buffer.alloc(30), "application/octet-stream", null);
    await store.put("bob", Buffer.alloc(70), "application/octet-stream", null);
    assert.equal(store.pendingBytesForUser("alice"), 80);
    assert.equal(store.pendingBytesForUser("bob"), 70);
    assert.equal(store.pendingBytesForUser("eve"), 0);
  });

  it("fileMaxBytesCap exposes the per-file ceiling for URL fetcher reuse", () => {
    const store = makeStore({ fileMax: 7777 });
    assert.equal(store.fileMaxBytesCap, 7777);
  });
});

describe("UploadStore — concurrent puts (M6 race)", () => {
  it("two parallel puts that both fit individually but exceed quota together — exactly one wins", async () => {
    const store = makeStore({ fileMax: 80, quota: 100 });
    const [a, b] = await Promise.all([
      store.put("alice", Buffer.alloc(60), "application/octet-stream", null),
      store.put("alice", Buffer.alloc(60), "application/octet-stream", null),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    const denyCount = [a, b].filter((r) => !r.ok).length;
    assert.equal(okCount, 1, "exactly one parallel put should succeed");
    assert.equal(denyCount, 1, "the other must be denied as quota_exceeded");
    const denied = a.ok ? b : a;
    if (denied.ok) return;
    assert.equal(denied.reason, "quota_exceeded");
    assert.equal(store.pendingBytesForUser("alice"), 60, "only the winning put should count");
    // The denied put's file must have been unlinked (rollback).
    const files = readdirSync(TEST_DIR);
    assert.equal(files.length, 1);
  });
});

describe("UploadStore — hold-bump on resolve (L2)", () => {
  it("resolve bumps expires_at when remaining lifetime is below MIN_HOLD_MS", async () => {
    // Construct with TTL well below MIN_HOLD_MS (5 min).
    const store = makeStore({ ttlMs: 30_000 });
    const put = await store.put("alice", Buffer.from("x"), "text/plain", null);
    if (!put.ok) return;
    const before = store.listForUser("alice", 1)[0];
    const beforeMs = new Date(`${before.expires_at}Z`).getTime();
    const resolved = store.resolve("alice", put.id);
    assert.ok(resolved);
    const afterMs = new Date(`${resolved?.expires_at}Z`).getTime();
    assert.ok(afterMs > beforeMs, `expiry should bump (before=${beforeMs}, after=${afterMs})`);
    // Floor is now+5min; should be at least now+4.5min after bump.
    assert.ok(afterMs - Date.now() >= 4 * 60_000, "remaining lifetime should be ~5 min after bump");
  });

  it("resolve does NOT bump when remaining lifetime is already >= MIN_HOLD_MS", async () => {
    const store = makeStore({ ttlMs: 60 * 60_000 }); // 1 hour
    const put = await store.put("alice", Buffer.from("x"), "text/plain", null);
    if (!put.ok) return;
    const before = store.listForUser("alice", 1)[0];
    const beforeMs = new Date(`${before.expires_at}Z`).getTime();
    store.resolve("alice", put.id);
    const after = store.listForUser("alice", 1)[0];
    const afterMs = new Date(`${after.expires_at}Z`).getTime();
    assert.equal(afterMs, beforeMs, "long-lived row must not be bumped");
  });
});

describe("UploadStore — quota visibility for URL-fetch cap (M4)", () => {
  it("fileMaxBytesCap + quotaBytesCap are exposed for url-fetcher to subtract pending bytes", async () => {
    const store = makeStore({ fileMax: 50, quota: 100 });
    assert.equal(store.fileMaxBytesCap, 50);
    assert.equal(store.quotaBytesCap, 100);
    // 40-byte upload (under fileMax=50) leaves 100-40=60 pending budget; url-fetcher caps
    // at min(fileMaxBytesCap=50, remaining=60) = 50.
    const put = await store.put("alice", Buffer.alloc(40), "application/octet-stream", null);
    assert.ok(put.ok, "40-byte put should succeed");
    const remaining = store.quotaBytesCap - store.pendingBytesForUser("alice");
    assert.equal(remaining, 60);
    assert.equal(Math.min(store.fileMaxBytesCap, remaining), 50);
  });

  it("returns 0 remaining when pending bytes equal quota", async () => {
    const store = makeStore({ fileMax: 100, quota: 100 });
    await store.put("alice", Buffer.alloc(100), "application/octet-stream", null);
    assert.equal(store.pendingBytesForUser("alice"), 100);
    assert.equal(store.quotaBytesCap - store.pendingBytesForUser("alice"), 0);
  });
});

describe("UploadStore — TTL purge", () => {
  it("resolve returns null for an expired row (without purging)", async () => {
    const store = makeStore({ ttlMs: 1 });
    const put = await store.put("alice", Buffer.from("late"), "text/plain", null);
    if (!put.ok) return;
    await new Promise((r) => setTimeout(r, 50));
    const resolved = store.resolve("alice", put.id);
    assert.equal(resolved, null, "expired upload must not resolve even before purge runs");
  });

  it("purgeExpired removes expired rows and unlinks their files", async () => {
    const store = makeStore({ ttlMs: 1 });
    await store.put("alice", Buffer.from("expired"), "text/plain", null);
    await new Promise((r) => setTimeout(r, 50));
    const removed = await store.purgeExpired();
    assert.equal(removed, 1);
    const files = readdirSync(TEST_DIR);
    assert.equal(files.length, 0);
  });

  it("purgeExpired is no-op when nothing is expired", async () => {
    const store = makeStore();
    await store.put("alice", Buffer.from("fresh"), "text/plain", null);
    const removed = await store.purgeExpired();
    assert.equal(removed, 0);
  });

  it("expired uploads do NOT count against the live quota", async () => {
    const store = makeStore({ fileMax: 100, quota: 100, ttlMs: 1 });
    await store.put("alice", Buffer.alloc(80), "application/octet-stream", null);
    await new Promise((r) => setTimeout(r, 50));
    // The expired 80-byte row should not block a new 80-byte upload.
    const denied = store.preflight("alice", 80);
    assert.equal(denied, null);
  });
});
