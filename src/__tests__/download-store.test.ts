import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOWNLOAD_LIMITS, DownloadStore } from "../download-store.js";

const source = (messageId = 1, accountId = 0, canRead = () => true) => ({
  chatId: "@chat",
  messageId,
  accountId,
  canRead,
});
const info = { fileId: "document:1:2", size: 9, mimeType: "audio/ogg", fileName: "voice.ogg" };

describe("DownloadStore tickets", () => {
  it("issues a ticket with metadata only and reuses it for the same owner, account and message", () => {
    const store = new DownloadStore();
    const a = store.issue("alice", source(), info);
    assert.match(a.metadata.downloadId, /^dl_[a-f0-9]{32}$/);
    assert.match(a.oneTimeToken, /^[A-Za-z0-9_-]{22}$/, "128-bit base64url token");
    assert.equal(a.reused, false);
    const b = store.issue("alice", source(), info);
    assert.equal(b.reused, true);
    assert.equal(b.metadata.downloadId, a.metadata.downloadId);
    assert.notEqual(b.oneTimeToken, a.oneTimeToken);
    assert.notEqual(store.issue("bob", source(), info).metadata.downloadId, a.metadata.downloadId);
    assert.notEqual(store.issue("alice", source(1, 9), info).metadata.downloadId, a.metadata.downloadId);
    assert.notEqual(
      store.issue("alice", source(), { ...info, fileId: "document:3:4" }).metadata.downloadId,
      a.metadata.downloadId,
      "replaced media of the same size gets a new ticket",
    );
  });

  it("one-time tokens work once and are replaced on reissue", () => {
    const store = new DownloadStore();
    const first = store.issue("alice", source(), info);
    const second = store.issue("alice", source(), info);
    assert.equal(store.redeem(first.oneTimeToken), null, "the previous token died on reissue");
    const ticket = store.redeem(second.oneTimeToken);
    assert.equal(ticket?.owner, "alice");
    assert.equal(ticket?.accountId, 0);
    assert.equal(ticket?.fileId, "document:1:2");
    assert.equal(store.redeem(second.oneTimeToken), null, "single use");
    assert.ok(store.get("alice", first.metadata.downloadId), "the ticket itself stays for MCP chunks");
  });

  it("the one-time link expires after linkTtlMs while the ticket lives on; asking again mints a working link", () => {
    let now = 1_000;
    const store = new DownloadStore(() => now);
    const t = store.issue("alice", source(), info);
    assert.equal(t.metadata.linkExpiresAt, new Date(1_000 + DOWNLOAD_LIMITS.linkTtlMs).toISOString());
    assert.ok(DOWNLOAD_LIMITS.linkTtlMs < DOWNLOAD_LIMITS.ttlMs);
    now += DOWNLOAD_LIMITS.linkTtlMs;
    assert.equal(store.redeem(t.oneTimeToken), null, "stale link refused");
    assert.ok(store.get("alice", t.metadata.downloadId), "ticket still serves MCP chunks");
    const again = store.issue("alice", source(), info);
    assert.equal(again.reused, true);
    assert.equal(store.redeem(again.oneTimeToken)?.owner, "alice", "a fresh link works");
  });

  it("a link never outlives its ticket", () => {
    let now = 0;
    const store = new DownloadStore(() => now);
    const t = store.issue("alice", source(), info);
    now = DOWNLOAD_LIMITS.ttlMs - 1_000;
    const late = store.issue("alice", source(), info);
    assert.equal(late.metadata.linkExpiresAt, t.metadata.expiresAt);
  });

  it("owner-scoped lookups, fixed TTL, and account binding", () => {
    let now = 1_000;
    let readable = true;
    const store = new DownloadStore(() => now);
    const t = store.issue(
      "alice",
      source(1, 0, () => readable),
      info,
    );
    assert.equal(store.get("bob", t.metadata.downloadId), null);
    assert.ok(store.get("alice", t.metadata.downloadId));
    readable = false;
    assert.equal(store.get("alice", t.metadata.downloadId), null, "detached account kills the ticket");
    assert.equal(store.redeem(t.oneTimeToken), null);
    readable = true;
    const u = store.issue("alice", source(2), info);
    now += DOWNLOAD_LIMITS.ttlMs - 1;
    assert.ok(store.get("alice", u.metadata.downloadId));
    now += 1;
    assert.equal(store.get("alice", u.metadata.downloadId), null);
    assert.equal(store.redeem(u.oneTimeToken), null);
  });

  it("evicts the owner's oldest ticket instead of refusing", () => {
    let now = 0;
    const store = new DownloadStore(() => now);
    const ids: string[] = [];
    for (let i = 0; i < DOWNLOAD_LIMITS.userTickets + 1; i++) {
      now++;
      ids.push(store.issue("alice", source(i + 1), info).metadata.downloadId);
    }
    assert.equal(store.get("alice", ids[0] as string), null);
    assert.ok(store.get("alice", ids.at(-1) as string));
  });

  it("sanitizes MIME and file name", () => {
    const store = new DownloadStore();
    const t = store.issue("alice", source(7), {
      fileId: "d:1",
      size: 1,
      mimeType: "text/html; x=<script>",
      fileName: "../‮evil",
    });
    assert.equal(t.metadata.mimeType, "application/octet-stream");
    assert.equal(t.metadata.fileName, "evil");
    const n = store.issue("alice", source(8), { fileId: "d:2", size: 1, mimeType: "IMAGE/PNG" });
    assert.equal(n.metadata.mimeType, "image/png");
    assert.equal(n.metadata.fileName, "media-8.png");
  });
});

describe("DownloadStore audit fixes", () => {
  it("tickets carry a shell-safe name next to the chat's own (M4)", () => {
    const store = new DownloadStore();
    const hostile = store.issue("alice", source(7), { ...info, fileName: "$(id)`x`.ogg" });
    assert.equal(hostile.metadata.fileName, "$(id)`x`.ogg", "display name kept as sent");
    assert.equal(hostile.metadata.safeFileName, "tg-7.ogg");
    const plain = store.issue("alice", source(8), info);
    assert.equal(plain.metadata.safeFileName, "tg-8-voice-tg.ogg");
    const agents = store.issue("alice", source(9), { ...info, fileName: "AGENTS.override.md" });
    assert.equal(agents.metadata.safeFileName, "tg-9-AGENTS_override-tg.md");
    const unnamed = store.issue("alice", source(10), { fileId: "document:5:6", size: 9, mimeType: "audio/ogg" });
    assert.equal(unnamed.metadata.fileName, "media-10.ogg");
    assert.equal(unnamed.metadata.safeFileName, "tg-10.ogg");
  });

  it("peek tells the owner of a live link without using it up (M1)", () => {
    let now = 0;
    const store = new DownloadStore(() => now);
    const t = store.issue("alice", source(), info);
    assert.equal(store.peek(t.oneTimeToken), "alice");
    assert.equal(store.peek(t.oneTimeToken), "alice", "peeking twice is fine");
    assert.equal(store.peek("AAAAAAAAAAAAAAAAAAAAAA"), null);
    assert.equal(store.redeem(t.oneTimeToken)?.owner, "alice", "the link still works after a peek");
    assert.equal(store.peek(t.oneTimeToken), null, "a used link is gone");
    const late = store.issue("alice", source(2), info);
    now += DOWNLOAD_LIMITS.linkTtlMs;
    assert.equal(store.peek(late.oneTimeToken), null, "an expired link is gone");
  });

  it("purging checks only the clock; reuse checks the binding of the one ticket it touches (L5)", () => {
    let now = 0;
    let checks = 0;
    let attached = true;
    const canRead = () => {
      checks++;
      return attached;
    };
    const store = new DownloadStore(() => now);
    for (let m = 1; m <= 5; m++) store.issue("alice", source(m, 0, canRead), info);
    checks = 0;
    store.purgeExpired();
    assert.equal(checks, 0, "no account lookups per ticket");
    // The account was replaced: asking again for the same message must not reuse the old ticket.
    attached = false;
    const fresh = store.issue(
      "alice",
      source(1, 0, () => true),
      info,
    );
    assert.equal(fresh.reused, false);
    assert.ok(store.get("alice", fresh.metadata.downloadId), "the new ticket is readable");
    now += DOWNLOAD_LIMITS.ttlMs;
    assert.equal(store.purgeExpired(), 5, "expired tickets still go");
  });
});
