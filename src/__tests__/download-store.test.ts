import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOWNLOAD_LIMITS, DownloadStore } from "../download-store.js";

const source = { chatId: "@chat", messageId: 1, canRead: () => true };
const result = { buffer: Buffer.from("OggSbytes"), mimeType: "audio/ogg" };

describe("DownloadStore limits and lifecycle", () => {
  it("holds a reservation across actual IO and releases it on failure", async () => {
    const store = new DownloadStore();
    let reject!: (e: Error) => void;
    const first = store.prepare(
      "alice",
      source,
      () =>
        new Promise((_r, j) => {
          reject = j;
        }),
    );
    await assert.rejects(() => store.prepare("alice", source, async () => result), /in progress/);
    reject(new Error("network failure"));
    await assert.rejects(() => first, /network failure/);
    assert.ok(await store.prepare("alice", source, async () => result));
  });

  it("global concurrent limit prevents more orphan downloads even from different owners", async () => {
    const store = new DownloadStore();
    const releases: (() => void)[] = [];
    const work = Array.from({ length: DOWNLOAD_LIMITS.concurrent }, (_, i) =>
      store.prepare(
        `owner${i}`,
        source,
        () =>
          new Promise((r) => {
            releases.push(() => r(result));
          }),
      ),
    );
    await assert.rejects(() => store.prepare("extra", source, async () => result), /server busy/);
    for (const release of releases) release();
    await Promise.all(work);
    assert.ok(await store.prepare("extra", source, async () => result));
  });

  it("rejects empty/oversized results and never publishes unauthorized late work", async () => {
    const store = new DownloadStore();
    for (const buffer of [Buffer.alloc(0), Buffer.alloc(DOWNLOAD_LIMITS.fileBytes + 1)]) {
      await assert.rejects(() => store.prepare("alice", source, async () => ({ ...result, buffer })), /Media must be/);
    }
    await assert.rejects(
      () => store.prepare("alice", { ...source, canRead: () => false }, async () => result),
      /no longer available/,
    );
    const meta = await store.prepare("alice", source, async () => result);
    assert.equal(store.read("bob", meta.downloadId), null);
    assert.ok(store.read("alice", meta.downloadId)); // stranger didn't delete the owner's file
  });

  it("enforces per-user file count BEFORE invoking Telegram", async () => {
    const store = new DownloadStore();
    let calls = 0;
    const load = async () => {
      calls++;
      return result;
    };
    for (let i = 0; i < DOWNLOAD_LIMITS.userFiles; i++) await store.prepare("alice", source, load);
    await assert.rejects(() => store.prepare("alice", source, load), /quota/);
    assert.equal(calls, DOWNLOAD_LIMITS.userFiles);
    assert.ok(await store.prepare("bob", source, load));
  });

  it("enforces per-user and global byte reservations BEFORE more IO", async () => {
    const store = new DownloadStore();
    const full = { ...result, buffer: Buffer.alloc(DOWNLOAD_LIMITS.fileBytes) };
    for (let i = 0; i < DOWNLOAD_LIMITS.userBytes / DOWNLOAD_LIMITS.fileBytes; i++) {
      await store.prepare("alice", source, async () => full);
    }
    await assert.rejects(
      () =>
        store.prepare("alice", source, async () => {
          throw new Error("must not download");
        }),
      /quota/,
    );
    for (let i = 0; i < (DOWNLOAD_LIMITS.totalBytes - DOWNLOAD_LIMITS.userBytes) / DOWNLOAD_LIMITS.fileBytes; i++) {
      await store.prepare(`owner${i}`, source, async () => full);
    }
    await assert.rejects(
      () =>
        store.prepare("extra", source, async () => {
          throw new Error("must not download");
        }),
      /quota/,
    );
  });

  it("purges on a fixed TTL; restart loses the snapshot; no keepalive via read", async () => {
    let now = 1000;
    const store = new DownloadStore(() => now);
    const meta = await store.prepare("alice", source, async () => result);
    now += DOWNLOAD_LIMITS.ttlMs - 1;
    assert.ok(store.read("alice", meta.downloadId));
    now++;
    assert.equal(store.purgeExpired(), 1);
    assert.equal(store.read("alice", meta.downloadId), null);
    assert.equal(new DownloadStore().read("alice", meta.downloadId), null);
  });

  it("sanitizes MIME/name and handles EOF and out-of-bounds offsets", async () => {
    const store = new DownloadStore();
    const meta = await store.prepare("alice", source, async () => ({
      ...result,
      mimeType: "text/html\r\nX-Evil: yes",
      fileName: "../../a\u202e\u0000.html",
    }));
    assert.equal(meta.mimeType, "application/octet-stream");
    assert.equal(meta.fileName, "a.html");
    assert.deepEqual(store.chunk("alice", meta.downloadId, "@chat", 1, result.buffer.length), {
      downloadId: meta.downloadId,
      offset: result.buffer.length,
      nextOffset: result.buffer.length,
      eof: true,
      base64: "",
    });
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.chunk("alice", meta.downloadId, "@chat", 1, offset), /safe integer/);
    }
    assert.throws(() => store.chunk("alice", meta.downloadId, "@chat", 1, result.buffer.length + 1), /exceeds/);
  });
});
