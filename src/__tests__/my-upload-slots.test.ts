/**
 * `POST /my/upload` takes its slots before it reads the body (audit M3): a request the
 * server can't run now is refused without buffering up to 50 MB of it, only a few bodies
 * sit in memory server-wide, a trickling body is cut off, and the parsed file goes to
 * core in fresh part-sized buffers instead of a second whole-file copy.
 */
// Same issuer as my-upload-auth.test.ts: config is read once per process.
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.UPLOAD_RATE_LIMIT = "1000";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { createMyRoutes } = await import("../routes/my.js");
const { bufferQueue, mediaTimeouts, transferQueue } = await import("../media-queue.js");

type Sent = { size: number; owned: boolean; largest: number };

function makeApp(appOpts: { uploadGate?: Promise<void> } = {}) {
  const sent: Sent[] = [];
  const sessions = {
    getSavedUserIds: () => [],
    getActiveAccountId: () => 0,
    getAccountAttachmentId: () => "attachment",
    listAccounts: (owner: string) => [{ accountId: 0, telegramUserId: owner, addedAt: "start" }],
    ensureAccountSession: async () => ({
      isConnected: () => true,
      uploadStream: async (
        source: AsyncIterable<Uint8Array>,
        size: number,
        name: string,
        _signal?: AbortSignal,
        opts?: { ownsChunks?: boolean },
      ) => {
        if (appOpts.uploadGate) await appOpts.uploadGate; // Telegram answers only when the test says so
        let received = 0;
        let largest = 0;
        for await (const chunk of source) {
          received += chunk.byteLength;
          largest = Math.max(largest, chunk.byteLength);
        }
        assert.equal(received, size);
        sent.push({ size, owned: opts?.ownsChunks === true, largest });
        return { kind: "uploaded-file", fileName: name, size, inputFile: {} };
      },
    }),
  };
  const uploads = {
    checkCapacity: () => null,
    put: () => ({ id: "upl_1", expiresAt: new Date("2030-01-01T00:00:00.000Z") }),
    listForUser: () => [],
    pendingCountForUser: () => 0,
  };
  const app = createMyRoutes({
    destructive: {} as never,
    sessions: sessions as never,
    uploads: uploads as never,
    oauth: { validateToken: () => ({ userId: "agent", clientName: "pi" }), getBrowserSessionUser: () => null } as never,
  });
  return { app, sent };
}

/** A multipart body that counts how many chunks the server pulled. */
async function watchedForm(fileBytes: number) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(fileBytes).fill(7)], "big.bin"));
  const req = new Request("https://x.invalid/", { method: "POST", body: form });
  // Bun drops the generated content-type once the body was read: take it first.
  const type = req.headers.get("content-type") ?? "";
  const raw = new Uint8Array(await req.arrayBuffer());
  let pulls = 0;
  const CHUNK = 16 * 1024;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      const at = pulls * CHUNK;
      pulls++;
      if (at >= raw.length) return c.close();
      c.enqueue(raw.subarray(at, at + CHUNK));
    },
  });
  return { stream, type, length: raw.length, pulled: () => pulls > 2 };
}

const post = (app: ReturnType<typeof makeApp>["app"], body: Awaited<ReturnType<typeof watchedForm>>) =>
  app.request("/upload", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": body.type, "content-length": String(body.length) },
    body: body.stream,
    duplex: "half",
  } as RequestInit);

describe("POST /my/upload slots", () => {
  it("a busy account is refused before its body is read", async () => {
    const f = makeApp();
    const held = [await transferQueue.acquire("agent"), await transferQueue.acquire("agent")];
    try {
      const body = await watchedForm(1024 * 1024);
      const res = await post(f.app, body);
      assert.equal(res.status, 429);
      assert.equal(body.pulled(), false, "the body was not buffered");
    } finally {
      for (const release of held) release();
    }
  });

  it("a full buffer pool waits without reading the body, then refuses and frees the transfer slot", async () => {
    const f = makeApp();
    const savedWait = bufferQueue.limits.waitMs;
    bufferQueue.limits.waitMs = 30;
    const held = [
      await bufferQueue.acquire("a"),
      await bufferQueue.acquire("a"),
      await bufferQueue.acquire("b"),
      await bufferQueue.acquire("b"),
    ];
    const baseline = transferQueue.stats().total;
    try {
      const body = await watchedForm(1024 * 1024);
      const res = await post(f.app, body);
      assert.equal(res.status, 429);
      assert.equal(body.pulled(), false);
    } finally {
      bufferQueue.limits.waitMs = savedWait;
      for (const release of held) release();
    }
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(transferQueue.stats().total, baseline);
  });

  it("hands the parsed file to core in fresh 512 KiB parts it may keep", async () => {
    const f = makeApp();
    const body = await watchedForm(1300 * 1024);
    const res = await post(f.app, body);
    assert.equal(res.status, 200);
    assert.deepEqual(f.sent, [{ size: 1300 * 1024, owned: true, largest: 512 * 1024 }]);
    assert.deepEqual(bufferQueue.stats(), { total: 0, waiting: 0 });
  });

  it("after a deadline answered the client, the buffer slot stays taken until the upload settles", async () => {
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { toolTransferMs: 30, backstopMs: 60_000 });
    let settle!: () => void;
    const gate = new Promise<void>((r) => {
      settle = r;
    });
    try {
      const f = makeApp({ uploadGate: gate });
      const res = await post(f.app, await watchedForm(64 * 1024));
      const answer = (await res.json()) as { error: string };
      assert.equal(answer.error, "UPLOAD_FAILED", `answered at the deadline: ${JSON.stringify(answer)} ${res.status}`);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bufferQueue.stats().total, 1, "the parsed file is still in memory, so its slot is held");
      settle();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bufferQueue.stats().total, 0, "freed once the upload settled");
    } finally {
      settle();
      Object.assign(mediaTimeouts, saved);
    }
  });

  it("a buffered body that does not arrive within bufferedBodyMs is refused", async () => {
    const saved = { ...mediaTimeouts };
    // The throughput guard is out of the way: only the body deadline can stop this.
    Object.assign(mediaTimeouts, { bufferedBodyMs: 60, minThroughputBytes: 0 });
    try {
      const f = makeApp();
      const full = await watchedForm(64 * 1024);
      const reader = full.stream.getReader();
      const first = (await reader.read()).value as Uint8Array;
      const stalled = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(first.subarray(0, 100));
        },
      });
      const started = Date.now();
      const res = await post(f.app, { ...full, stream: stalled });
      assert.ok(Date.now() - started < 2000);
      assert.equal(res.status, 408);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "TRANSFER_TOO_SLOW");
      assert.match(body.message, /did not arrive within/);
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });

  it("a trickling body is cut off with TRANSFER_TOO_SLOW", async () => {
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, {
      throughputWindowMs: 40,
      throughputCheckMs: 10,
      minThroughputBytes: 1024,
      throughputGraceMs: 0,
    });
    try {
      const f = makeApp();
      const full = await watchedForm(64 * 1024);
      const reader = full.stream.getReader();
      const first = (await reader.read()).value as Uint8Array;
      const stalled = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(first.subarray(0, 100)); // then nothing more
        },
      });
      const started = Date.now();
      const res = await post(f.app, { ...full, stream: stalled });
      assert.ok(Date.now() - started < 2000);
      assert.equal(res.status, 408);
      assert.equal(((await res.json()) as { error: string }).error, "TRANSFER_TOO_SLOW");
      assert.deepEqual(f.sent, []);
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });
});
