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
