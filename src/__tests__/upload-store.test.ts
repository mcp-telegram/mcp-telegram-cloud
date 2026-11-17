import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UploadedFile } from "@overpod/mcp-telegram/service";
import { MAX_PENDING_UPLOADS_PER_USER, UploadStore } from "../upload-store.js";

const TTL = 15 * 60_000;
const file = (name = "a.pdf", size = 100) =>
  ({ kind: "uploaded-file", fileName: name, size }) as unknown as UploadedFile;
const binding = (accountId = 0, canUse = () => true) => ({ accountId, canUse });

describe("UploadStore — uploaded handles (memory only)", () => {
  it("put / resolve / consume are owner-scoped and single-use", () => {
    const store = new UploadStore(TTL);
    const { id } = store.put("alice", binding(), file(), "application/pdf", "a.pdf");
    assert.match(id, /^upl_[a-f0-9]{32}$/);
    assert.equal(store.resolve("bob", id), null);
    const found = store.resolve("alice", id);
    assert.equal(found?.file.fileName, "a.pdf");
    assert.equal(found?.accountId, 0);
    assert.ok(store.consume("alice", id));
    assert.equal(store.consume("alice", id), null);
    assert.equal(store.resolve("alice", id), null);
  });

  it("expires after the TTL and when the account binding breaks", () => {
    let now = 0;
    let usable = true;
    const store = new UploadStore(TTL, () => now);
    const a = store.put(
      "alice",
      binding(0, () => usable),
      file(),
      "x",
      null,
    );
    const b = store.put("alice", binding(), file(), "x", null);
    usable = false;
    assert.equal(store.resolve("alice", a.id), null);
    now = TTL;
    assert.equal(store.resolve("alice", b.id), null);
    assert.equal(store.purgeExpired(), 0, "resolve already dropped both");
  });

  it("lists the user's uploads for the dashboard and counts their bytes", () => {
    const store = new UploadStore(TTL);
    store.put("alice", binding(), file("a.pdf", 10), "application/pdf", "a.pdf");
    store.put("alice", binding(), file("b.pdf", 20), "application/pdf", "b.pdf");
    store.put("bob", binding(), file("c.pdf", 40), "application/pdf", "c.pdf");
    const rows = store.listForUser("alice");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.user_id === "alice"));
    assert.match(rows[0]?.expires_at ?? "", /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.equal(store.pendingBytesForUser("alice"), 30);
    assert.equal(store.pendingBytesTotal(), 70);
  });
});

describe("UploadStore — one-time upload links", () => {
  it("a link reserves an upload id, works once, and becomes the ready upload", () => {
    const store = new UploadStore(TTL);
    const link = store.createLink("alice", binding(3), "clip.mp4", 1234);
    assert.ok(!("error" in link));
    assert.match(link.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(store.resolve("alice", link.uploadId), null, "not ready before the PUT");
    assert.equal(store.isAwaitingLink("alice", link.uploadId), true);
    assert.equal(store.isAwaitingLink("bob", link.uploadId), false);
    assert.equal(store.peekLink(link.token)?.size, 1234, "peek does not use the link");
    const claimed = store.claimLink(link.token);
    assert.equal(claimed?.uploadId, link.uploadId);
    assert.equal(claimed?.owner, "alice");
    assert.equal(claimed?.accountId, 3);
    assert.equal(store.claimLink(link.token), null, "single use");
    assert.equal(store.peekLink(link.token), null);
    store.put("alice", binding(3), file("clip.mp4", 1234), "video/mp4", "clip.mp4", claimed?.uploadId);
    assert.equal(store.resolve("alice", link.uploadId)?.file.size, 1234);
  });

  it("links expire and die with the account binding", () => {
    let now = 0;
    let usable = true;
    const store = new UploadStore(TTL, () => now);
    const a = store.createLink(
      "alice",
      binding(0, () => usable),
      "a",
      1,
    );
    const b = store.createLink("alice", binding(), "b", 1);
    assert.ok(!("error" in a) && !("error" in b));
    usable = false;
    assert.equal(store.claimLink(a.token), null);
    now = TTL;
    assert.equal(store.claimLink(b.token), null);
  });

  it("caps pending uploads plus open links per user", () => {
    const store = new UploadStore(TTL);
    for (let i = 0; i < MAX_PENDING_UPLOADS_PER_USER - 1; i++) store.put("alice", binding(), file(), "x", null);
    assert.ok(!("error" in store.createLink("alice", binding(), "last", 1)));
    const refused = store.createLink("alice", binding(), "one-too-many", 1);
    assert.ok("error" in refused);
    assert.ok(store.checkCapacity("alice"));
    assert.equal(store.checkCapacity("bob"), null);
  });
});
