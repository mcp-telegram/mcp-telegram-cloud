process.env.ISSUER ??= "https://download-attachment-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DownloadStore } from "../download-store.js";

const { SessionManager } = await import("../session-manager.js");
const { READ_TOOLS } = await import("../tools/read.js");
const found = READ_TOOLS.find((t) => t.name === "telegram-download-media");
assert.ok(found);
const tool = found;
const bytes = Buffer.from("OggSvoice");
const media = { buffer: bytes, mimeType: "audio/ogg", isThumb: false };

function setup() {
  const sessions = new SessionManager(":memory:");
  const downloads = new DownloadStore();
  sessions.saveSessionString("alice", "first-auth-key");
  const attachment = sessions.getAccountAttachmentId("alice", 0);
  assert.ok(attachment);
  const addedAt = sessions.listAccounts("alice")[0].addedAt;
  const recreate = async () => {
    await sessions.destroyUserSession("alice");
    sessions.saveSessionString("alice", "new-auth-key");
    // Deterministically reproduce the same-second tuple — no timing dependence.
    sessions.getDb().prepare("UPDATE user_sessions SET created_at = ? WHERE user_id = ?").run(addedAt, "alice");
    assert.equal(sessions.listAccounts("alice")[0].addedAt, addedAt);
    assert.notEqual(sessions.getAccountAttachmentId("alice", 0), attachment);
  };
  const deps = {
    sessions,
    downloads,
    userId: "alice",
    sourceAccountId: 0,
    sourceAttachmentId: attachment,
    baseUrl: "https://download-attachment-test.invalid",
    telegram: { downloadMediaBounded: async () => media },
  };
  return { sessions, downloads, attachment, recreate, deps };
}

describe("private download attachment identity", () => {
  it("removal + same-second primary recreation cannot revive a completed snapshot", async () => {
    const f = setup();
    try {
      const prepared = await tool.handler({ chatId: "@chat", messageId: 1, file: true }, f.deps as never);
      const id = String(prepared.structuredContent?.downloadId);
      assert.ok(f.downloads.read("alice", id));
      await f.recreate();
      assert.equal(f.downloads.read("alice", id), null);
      await assert.rejects(
        () => tool.handler({ chatId: "@chat", messageId: 1, downloadId: id }, f.deps as never),
        /unavailable/,
      );
    } finally {
      f.sessions.getDb().close();
    }
  });

  it("removal + same-second recreation also denies pending old IO at completion", async () => {
    const f = setup();
    let finish!: () => void;
    const oldIo = new Promise<typeof media>((resolve) => {
      finish = () => resolve(media);
    });
    const pending = tool.handler({ chatId: "@chat", messageId: 1, file: true }, {
      ...f.deps,
      telegram: { downloadMediaBounded: () => oldIo },
    } as never);
    try {
      await f.recreate();
      finish();
      await assert.rejects(() => pending, /no longer available/);
    } finally {
      finish();
      f.sessions.getDb().close();
    }
  });

  it("upserts preserve attachment identity; legacy empty defaults from old rollout tasks are filled lazily", () => {
    const f = setup();
    try {
      f.sessions.saveSessionString("alice", "saved-existing-auth-key");
      assert.equal(f.sessions.getAccountAttachmentId("alice", 0), f.attachment);
      assert.equal(f.sessions.getAccountAttachmentId("alice", 12345), null);
      f.sessions
        .getDb()
        .prepare("INSERT INTO user_sessions (user_id, session_string) VALUES (?, ?)")
        .run("legacy", "key");
      const id = f.sessions.getAccountAttachmentId("legacy", 0);
      assert.match(id ?? "", /^[a-f0-9]{32}$/);
      assert.equal(f.sessions.getAccountAttachmentId("legacy", 0), id);
    } finally {
      f.sessions.getDb().close();
    }
  });
});
