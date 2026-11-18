// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-uploads-filename-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UploadedFile } from "@overpod/mcp-telegram/service";

const { TOOLS } = await import("../tools.js");
const { UploadStore } = await import("../upload-store.js");
const { UrlFetchError } = await import("../url-fetcher.js");

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  assert.ok(found, name);
  return found;
}
const sendFileTool = tool("telegram-send-file");
const sendAlbumTool = tool("telegram-send-album");
const sendVoiceTool = tool("telegram-send-voice");
const linkTool = tool("telegram-create-upload-link");

const handle = (fileName: string, size = 10) =>
  ({ kind: "uploaded-file", fileName, size, inputFile: {} }) as unknown as UploadedFile;

type StreamCall = { size: number; name: string; received: number; chunks: number; owned?: true };

/** Deps double: a real UploadStore, a recording Telegram client and a scripted URL opener. */
function makeHarness(
  opts: {
    throwOnSend?: Error;
    url?: { size: number | undefined; chunks: Uint8Array[]; failWith?: Error; hang?: boolean };
    activeAccount?: number;
    detachDuringUpload?: boolean;
    urlDelayMs?: number;
  } = {},
) {
  let attachment = "attachment";
  const uploads = new UploadStore(15 * 60_000);
  const sendFileCalls: Array<{ chatId: string; file: UploadedFile; caption?: string }> = [];
  const sendVoiceCalls: Array<{ file: UploadedFile }> = [];
  const albumCalls: Array<Array<{ filePath: UploadedFile; caption?: string }>> = [];
  const streamCalls: StreamCall[] = [];
  let cancelled = 0;
  const telegram = {
    openMedia: async () => ({}),
    uploadStream: async (
      source: AsyncIterable<Uint8Array>,
      size: number,
      name: string,
      _signal?: AbortSignal,
      uploadOpts?: { ownsChunks?: boolean },
    ) => {
      let received = 0;
      let chunks = 0;
      for await (const c of source) {
        received += c.byteLength;
        chunks++;
      }
      streamCalls.push({ size, name, received, chunks, ...(uploadOpts?.ownsChunks && { owned: true }) });
      if (opts.detachDuringUpload) attachment = "replaced";
      return handle(name, size);
    },
    sendFile: async (chatId: string, file: UploadedFile, caption?: string) => {
      sendFileCalls.push({ chatId, file, ...(caption !== undefined && { caption }) });
      if (opts.throwOnSend) throw opts.throwOnSend;
    },
    sendVoice: async (_chatId: string, file: UploadedFile) => {
      sendVoiceCalls.push({ file });
      return { id: 7 };
    },
    sendAlbum: async (_chatId: string, items: Array<{ filePath: UploadedFile; caption?: string }>) => {
      albumCalls.push(items);
      return { ids: [1, 2] };
    },
  };
  const openUrl = async () => {
    if (opts.urlDelayMs) await new Promise((r) => setTimeout(r, opts.urlDelayMs));
    const u: { size: number | undefined; chunks: Uint8Array[]; failWith?: Error; hang?: boolean } = opts.url ?? {
      size: 7,
      chunks: [Buffer.from("payload")],
    };
    return {
      ok: true as const,
      size: u.size,
      mime: "application/pdf",
      finalUrl: "https://example.com/x",
      cancel: () => {
        cancelled++;
      },
      body: (async function* () {
        for (const c of u.chunks) yield c;
        if (u.hang) await new Promise(() => {});
        if (u.failWith) throw u.failWith;
      })(),
    };
  };
  const sessions = {
    listAccounts: () => [{ accountId: 0, telegramUserId: "u1", addedAt: "start" }],
    getAccountAttachmentId: () => attachment,
  };
  const deps = {
    telegram,
    uploads,
    openUrl,
    sessions,
    userId: "u1",
    sourceAccountId: opts.activeAccount ?? 0,
    sourceAttachmentId: "attachment",
    baseUrl: "https://tools-uploads-filename-test.invalid",
  } as never;
  const put = (name: string, accountId = 0) =>
    uploads.put("u1", { accountId, canUse: () => true }, handle(name), "x", name).id;
  return {
    deps,
    uploads,
    put,
    sendFileCalls,
    sendVoiceCalls,
    albumCalls,
    streamCalls,
    cancelled: () => cancelled,
    detach: () => {
      attachment = "replaced";
    },
  };
}

const text = (res: unknown) => JSON.stringify((res as { content: unknown }).content);

describe("telegram-send-file — uploaded handles reach Telegram", () => {
  it("passes the upload's handle and echoes its name", async () => {
    const h = makeHarness();
    const id = h.put("review_git-delivery-2026-09-18_2026-09-21.md");
    const res = await sendFileTool.handler(
      { chatId: "5589006450", source: { kind: "upload", uploadId: id }, caption: "отчёт" },
      h.deps,
    );
    assert.equal(h.sendFileCalls.length, 1);
    assert.equal(h.sendFileCalls[0]?.file.fileName, "review_git-delivery-2026-09-18_2026-09-21.md");
    assert.equal(h.sendFileCalls[0]?.caption, "отчёт");
    assert.match(text(res), /review_git-delivery-2026-09-18_2026-09-21\.md/);
    assert.match(text(res), /telegram-read-messages/, "tells the agent to confirm via history");
  });

  it("consumes the upload on success AND when the send throws", async () => {
    const ok = makeHarness();
    const okId = ok.put("a.md");
    await sendFileTool.handler({ chatId: "@me", source: { kind: "upload", uploadId: okId } }, ok.deps);
    assert.equal(ok.uploads.resolve("u1", okId), null);

    const boom = makeHarness({ throwOnSend: new Error("FILE_PART_MISSING") });
    const boomId = boom.put("a.md");
    await assert.rejects(
      () => sendFileTool.handler({ chatId: "@me", source: { kind: "upload", uploadId: boomId } }, boom.deps),
      /FILE_PART_MISSING/,
      "handler must not swallow the upstream failure",
    );
    assert.equal(boom.uploads.resolve("u1", boomId), null, "cleanup must run on the failure path too");
  });

  it("refuses unknown, pending-link and other-account uploads with codes", async () => {
    const h = makeHarness({ activeAccount: 0 });
    const missing = await sendFileTool.handler(
      { chatId: "@me", source: { kind: "upload", uploadId: "upl_x" } },
      h.deps,
    );
    assert.match(text(missing), /\[UPLOAD_NOT_FOUND\]/);
    const link = h.uploads.createLink("u1", { accountId: 0, canUse: () => true }, "a.pdf", 3);
    assert.ok(!("error" in link));
    const waiting = await sendFileTool.handler(
      { chatId: "@me", source: { kind: "upload", uploadId: link.uploadId } },
      h.deps,
    );
    assert.match(text(waiting), /\[UPLOAD_NOT_FOUND\].*not been used yet/);
    const other = h.put("b.pdf", 9);
    const mismatch = await sendFileTool.handler({ chatId: "@me", source: { kind: "upload", uploadId: other } }, h.deps);
    assert.match(text(mismatch), /\[UPLOAD_ACCOUNT_MISMATCH\]/);
    assert.equal(h.sendFileCalls.length, 0);
  });
});

describe("URL sources stream into Telegram", () => {
  it("streams a body with a known length chunk by chunk, named after the last path segment", async () => {
    const chunks = [Buffer.alloc(300_000, 1), Buffer.alloc(300_000, 2), Buffer.alloc(5, 3)];
    const h = makeHarness({ url: { size: 600_005, chunks } });
    await sendFileTool.handler(
      { chatId: "@me", source: { kind: "url", url: "https://example.com/docs/spec%20v2.pdf?sig=abc" } },
      h.deps,
    );
    assert.deepEqual(h.streamCalls, [{ size: 600_005, name: "spec v2.pdf", received: 600_005, chunks: 3 }]);
    assert.equal(h.sendFileCalls[0]?.file.fileName, "spec v2.pdf");
    assert.equal(h.cancelled(), 1, "the HTTP response is always released");
  });

  it("buffers in memory only when the length is unknown", async () => {
    const h = makeHarness({ url: { size: undefined, chunks: [Buffer.from("ab"), Buffer.from("cde")] } });
    await sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a.txt" } }, h.deps);
    // Parts go to core one by one (no joined copy), marked as owned so core skips its copy.
    assert.deepEqual(h.streamCalls, [{ size: 5, name: "a.txt", received: 5, chunks: 2, owned: true }]);
  });

  it("a body of unknown length waits for a slot of the small buffer pool; a known length does not", async () => {
    const { bufferQueue } = await import("../media-queue.js");
    const savedWait = bufferQueue.limits.waitMs;
    const held = [await bufferQueue.acquire("other-1"), await bufferQueue.acquire("other-1")];
    held.push(await bufferQueue.acquire("other-2"), await bufferQueue.acquire("other-2"));
    bufferQueue.limits.waitMs = 20;
    try {
      const unknown = makeHarness({ url: { size: undefined, chunks: [Buffer.from("ab")] } });
      await assert.rejects(
        () =>
          sendFileTool.handler(
            { chatId: "@me", source: { kind: "url", url: "https://example.com/a.txt" } },
            unknown.deps,
          ),
        (e: Error & { code?: string }) => e.code === "TRANSFER_BUSY",
      );
      assert.equal(unknown.streamCalls.length, 0, "nothing was buffered while the pool was full");
      const known = makeHarness({ url: { size: 2, chunks: [Buffer.from("ab")] } });
      await sendFileTool.handler(
        { chatId: "@me", source: { kind: "url", url: "https://example.com/a.txt" } },
        known.deps,
      );
      assert.equal(known.streamCalls.length, 1, "a streamed source needs no buffer slot");
    } finally {
      bufferQueue.limits.waitMs = savedWait;
      for (const release of held) release();
    }
    assert.equal(bufferQueue.stats().total, 0);
  });

  it("maps fetch failures to URL_FETCH_DENIED", async () => {
    const h = makeHarness({
      url: { size: 10, chunks: [Buffer.from("abc")], failWith: new UrlFetchError("too_large", "Body exceeded cap") },
    });
    await assert.rejects(
      () => sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps),
      (e: Error & { code?: string }) => e.code === "URL_FETCH_DENIED" && /too_large/.test(e.message),
    );
    let thrown: unknown;
    try {
      await sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps);
    } catch (e) {
      thrown = e;
    }
    const result = (await sendFileTool.onError?.(thrown)) as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /^\[URL_FETCH_DENIED\] /);
  });
});

describe("URL sources are bounded and bound to the account", () => {
  it("a body that stops arriving times out, closes the response and frees the slot", async () => {
    const { mediaTimeouts, transferQueue } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { toolTransferMs: 30, backstopMs: 60 });
    try {
      const h = makeHarness({ url: { size: 10, chunks: [Buffer.from("abc")], hang: true } });
      const baseline = transferQueue.stats().total;
      const started = Date.now();
      await assert.rejects(
        () => sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps),
        (e: Error & { code?: string }) => e.code === "UPLOAD_FAILED",
      );
      assert.ok(Date.now() - started < 1000);
      assert.ok(h.cancelled() >= 1, "the HTTP response was closed on abort");
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(transferQueue.stats().total, baseline, "slot freed by the backstop");
      assert.equal(h.sendFileCalls.length, 0);
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });

  it("does not send a URL upload if the account was detached while it uploaded", async () => {
    const h = makeHarness({ detachDuringUpload: true });
    const res = await sendFileTool.handler(
      { chatId: "@me", source: { kind: "url", url: "https://example.com/a.pdf" } },
      h.deps,
    );
    assert.match(text(res), /\[ACCOUNT_UNAVAILABLE\]/);
    assert.equal(h.sendFileCalls.length, 0);
  });
});

describe("sends go through the shared slot, deadline and binding check", () => {
  it("nothing is sent through an account detached after the upload was resolved", async () => {
    const h = makeHarness();
    const id = h.put("a.pdf");
    h.detach();
    await assert.rejects(
      () => sendFileTool.handler({ chatId: "@me", source: { kind: "upload", uploadId: id } }, h.deps),
      (e: Error & { code?: string }) => e.code === "ACCOUNT_UNAVAILABLE" && /nothing was sent/.test(e.message),
    );
    assert.equal(h.sendFileCalls.length, 0);
  });

  it("a send Telegram never confirms is reported as unconfirmed, the slot freed and the client marked", async () => {
    const { mediaTimeouts, transferQueue } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { toolTransferMs: 30, backstopMs: 60 });
    try {
      const h = makeHarness();
      const id = h.put("a.pdf");
      const d = h.deps as unknown as { telegram: Record<string, unknown>; sessions: Record<string, unknown> };
      const marked: unknown[] = [];
      const telegram = { ...d.telegram, sendFile: () => new Promise(() => {}) };
      const deps = {
        ...d,
        telegram,
        sessions: { ...d.sessions, markUnhealthy: (_o: string, t: { expected: unknown }) => marked.push(t.expected) },
      };
      const baseline = transferQueue.stats().total;
      await assert.rejects(
        () => sendFileTool.handler({ chatId: "@me", source: { kind: "upload", uploadId: id } }, deps as never),
        (e: Error & { code?: string }) => e.code === "SEND_UNCONFIRMED" && /may still arrive/.test(e.message),
      );
      assert.deepEqual(marked, [telegram]);
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(transferQueue.stats().total, baseline);
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });
});

describe("one time budget per tool call", () => {
  it("album item uploads and the send share the call's budget instead of restarting it", async () => {
    const { mediaTimeouts } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { toolTransferMs: 100, backstopMs: 60 });
    try {
      // Each URL upload takes 70 ms: alone it fits the 100 ms budget, together they don't.
      const h = makeHarness({ urlDelayMs: 70 });
      const started = Date.now();
      await assert.rejects(
        () =>
          sendAlbumTool.handler(
            {
              chatId: "@me",
              items: [
                { source: { kind: "url", url: "https://example.com/a.pdf" } },
                { source: { kind: "url", url: "https://example.com/b.pdf" } },
              ],
            },
            h.deps,
          ),
        (e: Error & { code?: string }) => e.code === "UPLOAD_FAILED",
      );
      assert.ok(Date.now() - started < 400, "answered within the budget, not after a fresh one per step");
      assert.equal(h.albumCalls.length, 0, "nothing was sent after the budget ran out");
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });
});

describe("telegram-send-album / telegram-send-voice — same resolver", () => {
  it("passes each album member's handle", async () => {
    const h = makeHarness();
    const a = h.put("first.pdf");
    const b = h.put("second.pdf");
    await sendAlbumTool.handler(
      {
        chatId: "@me",
        items: [
          { source: { kind: "upload", uploadId: a }, caption: "one" },
          { source: { kind: "upload", uploadId: b } },
        ],
      },
      h.deps,
    );
    assert.deepEqual(
      h.albumCalls[0]?.map((i) => [i.filePath.fileName, i.caption]),
      [
        ["first.pdf", "one"],
        ["second.pdf", undefined],
      ],
    );
  });

  it("passes the handle to sendVoice so the codec is detectable from its name", async () => {
    const h = makeHarness();
    const id = h.put("note.ogg");
    await sendVoiceTool.handler({ chatId: "@me", source: { kind: "upload", uploadId: id } }, h.deps);
    assert.equal(h.sendVoiceCalls[0]?.file.fileName, "note.ogg");
  });
});

describe("telegram-create-upload-link", () => {
  it("returns a one-time PUT url, an uploadId and a curl example bound to the active account", async () => {
    const h = makeHarness();
    const res = await linkTool.handler({ fileName: "../report.pdf", size: 1234 }, h.deps);
    const out = res.structuredContent as {
      uploadId: string;
      url: string;
      method: string;
      curl: string;
      fileName: string;
    };
    assert.match(out.uploadId, /^upl_[a-f0-9]{32}$/);
    assert.match(out.url, /^https:\/\/tools-uploads-filename-test\.invalid\/u\/[A-Za-z0-9_-]{22}$/);
    assert.equal(out.method, "PUT");
    assert.equal(out.fileName, "report.pdf");
    assert.match(out.curl, /^curl -fsS -T '<path to the local file>' 'https:\/\/.*\/u\//);
    const token = out.url.split("/u/")[1] as string;
    const claimed = h.uploads.peekLink(token);
    assert.equal(claimed?.size, 1234);
    assert.equal(claimed?.accountId, 0);
    assert.equal(h.uploads.isAwaitingLink("u1", out.uploadId), true);
  });
});

describe("buffered URL sources hold their buffer slot until the upload settles", () => {
  it("a deadline answers the call, the slot stays until Telegram is done", async () => {
    const { bufferQueue, mediaTimeouts } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { toolTransferMs: 30, backstopMs: 60_000 });
    let settle!: () => void;
    const gate = new Promise<void>((r) => {
      settle = r;
    });
    try {
      const h = makeHarness({ url: { size: undefined, chunks: [Buffer.from("abc")] } });
      const telegram = (h.deps as unknown as { telegram: { uploadStream: (...a: unknown[]) => Promise<unknown> } })
        .telegram;
      const original = telegram.uploadStream;
      telegram.uploadStream = async (...args: unknown[]) => {
        await gate;
        return original(...args);
      };
      await assert.rejects(
        () => sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps),
        (e: Error & { code?: string }) => e.code === "UPLOAD_FAILED" || e.code === "SEND_UNCONFIRMED",
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bufferQueue.stats().total, 1, "the buffered parts are still held");
      settle();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bufferQueue.stats().total, 0);
    } finally {
      settle();
      Object.assign(mediaTimeouts, saved);
    }
  });
});

describe("URL uploads that never finish (audit round 3)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Harness whose Telegram upload takes the first chunk, then waits forever on a sent part. */
  const hangingUpload = (url: { size: number | undefined; chunks: Uint8Array[]; hang?: boolean }) => {
    const h = makeHarness({ url });
    const telegram = (h.deps as unknown as { telegram: { uploadStream: unknown } }).telegram;
    telegram.uploadStream = async (source: AsyncIterable<Uint8Array>) => {
      const it = source[Symbol.asyncIterator]();
      await it.next();
      // Core waits for parts already sent; this one never settles and ignores the signal.
      void it.next().catch(() => {});
      return new Promise(() => {});
    };
    return h;
  };

  it("a buffered upload that never settles gives its buffer slot back at the backstop", async () => {
    const { bufferQueue, mediaTimeouts, transferQueue } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { toolTransferMs: 30, backstopMs: 80 });
    try {
      const baseline = transferQueue.stats().total;
      const h = hangingUpload({ size: undefined, chunks: [Buffer.from("abc")] });
      await assert.rejects(
        () => sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps),
        (e: Error & { code?: string }) => e.code === "UPLOAD_FAILED",
      );
      await sleep(20);
      assert.equal(bufferQueue.stats().total, 1, "held while the upload may still use the parts");
      await sleep(150);
      assert.equal(bufferQueue.stats().total, 0, "freed with the transfer slot at the backstop");
      assert.equal(transferQueue.stats().total, baseline);
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });

  it("a known-length URL that stops sending while a part hangs is answered TRANSFER_TOO_SLOW at once", async () => {
    const { mediaTimeouts, transferQueue } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, {
      toolTransferMs: 3000,
      backstopMs: 100,
      throughputWindowMs: 40,
      throughputCheckMs: 10,
      minThroughputBytes: 1024,
      throughputGraceMs: 0,
    });
    try {
      const baseline = transferQueue.stats().total;
      const h = hangingUpload({ size: 10_000, chunks: [Buffer.from("abc")], hang: true });
      const started = Date.now();
      await assert.rejects(
        () => sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps),
        (e: Error & { code?: string }) => e.code === "TRANSFER_TOO_SLOW",
      );
      assert.ok(Date.now() - started < 1000, "answered by the guard, not the call deadline");
      await sleep(20);
      assert.equal(transferQueue.stats().total, baseline + 1, "the slot stays while the part is pending");
      await sleep(150);
      assert.equal(transferQueue.stats().total, baseline, "and goes at the backstop");
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });
});

describe("buffered URL bodies have a deadline (audit round 4)", () => {
  it("a body of unknown length that does not arrive within bufferedBodyMs fails at once", async () => {
    const { bufferQueue, mediaTimeouts } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { bufferedBodyMs: 60, minThroughputBytes: 0, backstopMs: 100 });
    try {
      const h = makeHarness({ url: { size: undefined, chunks: [Buffer.from("abc")], hang: true } });
      const started = Date.now();
      await assert.rejects(
        () => sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps),
        (e: Error & { code?: string }) => e.code === "TRANSFER_TOO_SLOW" && /did not arrive within/.test(e.message),
      );
      assert.ok(Date.now() - started < 2000, "not the call deadline");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(bufferQueue.stats().total, 0);
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });
});

describe("sends have their own pool (audit M1)", () => {
  it("a send goes out while long streams hold every transfer slot of the account", async () => {
    const { transferQueue } = await import("../media-queue.js");
    const savedWait = transferQueue.limits.waitMs;
    const held = [await transferQueue.acquire("u1"), await transferQueue.acquire("u1")];
    transferQueue.limits.waitMs = 20;
    try {
      const h = makeHarness();
      const id = h.put("report.pdf");
      await sendFileTool.handler({ chatId: "@me", source: { kind: "upload", uploadId: id } }, h.deps);
      assert.equal(h.sendFileCalls.length, 1);
    } finally {
      transferQueue.limits.waitMs = savedWait;
      for (const release of held) release();
    }
  });
});

describe("telegram-create-upload-link recipe (audit M4)", () => {
  it("never echoes the supplied name into the curl command", async () => {
    const link = tool("telegram-create-upload-link");
    const uploads = new UploadStore(15 * 60_000);
    const deps = {
      uploads,
      userId: "u1",
      sessions: {
        listAccounts: () => [{ accountId: 0, telegramUserId: "u1", addedAt: "start" }],
        getAccountAttachmentId: () => "attachment",
      },
      baseUrl: "https://tools-uploads-filename-test.invalid",
      sourceAccountId: 0,
      sourceAttachmentId: "attachment",
    } as never;
    const res = await link.handler({ fileName: "$(touch pwned)`id`;x.pdf", size: 3 }, deps);
    const out = res.structuredContent as { curl: string; fileName: string };
    assert.equal(out.fileName, "$(touch pwned)`id`;x.pdf", "the name the recipient sees is kept");
    assert.match(out.curl, /^curl -fsS -T '<path to the local file>' 'https:\/\/[^']+'$/);
    assert.ok(!out.curl.includes("touch") && !out.curl.includes("pdf"), "the supplied name is not echoed");
  });
});

describe("URL sources are cut off when the remote server trickles (audit M1)", () => {
  it("a body that stops arriving fails with TRANSFER_TOO_SLOW long before the call deadline", async () => {
    const { mediaTimeouts } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, {
      throughputWindowMs: 40,
      throughputCheckMs: 10,
      minThroughputBytes: 1024,
      throughputGraceMs: 0,
    });
    try {
      for (const size of [10, undefined]) {
        const h = makeHarness({ url: { size, chunks: [Buffer.from("abc")], hang: true } });
        const started = Date.now();
        await assert.rejects(
          () => sendFileTool.handler({ chatId: "@me", source: { kind: "url", url: "https://example.com/a" } }, h.deps),
          (e: Error & { code?: string }) => e.code === "TRANSFER_TOO_SLOW",
        );
        assert.ok(Date.now() - started < 2000);
        assert.ok(h.cancelled() >= 1, "the HTTP response was closed");
      }
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });
});

describe("URL fetch denials are logged by reason only (audit round 4, L5)", () => {
  it("the user's URL, host and redirect target never reach the log", async () => {
    const { logger } = await import("../logger.js");
    const { MediaError } = await import("../media-errors.js");
    const lines: string[] = [];
    const saved = logger.warn;
    logger.warn = ((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    }) as typeof logger.warn;
    try {
      for (const message of [
        "URL fetch denied (bad_url): Not a valid URL: https://user:secret@files.example/signed?sig=abc",
        "URL fetch denied (dns_failure): DNS lookup failed for secret-host.example: ENOTFOUND",
        "URL fetch denied (redirect_missing_location): Redirect to https://user:secret@files.example/x",
      ]) {
        const result = (await sendFileTool.onError?.(new MediaError("URL_FETCH_DENIED", message))) as {
          content: Array<{ text: string }>;
        };
        assert.match(result.content[0]?.text ?? "", /secret/, "the caller still sees the full reason");
      }
    } finally {
      logger.warn = saved;
    }
    const logged = lines.join("\n");
    assert.ok(!/secret|files\.example|signed/.test(logged), logged);
    assert.match(logged, /\[URL_FETCH_DENIED\] bad_url/);
    assert.match(logged, /\[URL_FETCH_DENIED\] dns_failure/);
  });
});

describe("upload links: 5 minutes, optional sha256 (audit round 4, L3)", () => {
  const linkTool = tool("telegram-create-upload-link");
  const linkDeps = (uploads: InstanceType<typeof UploadStore>) =>
    ({
      uploads,
      userId: "u1",
      sessions: {
        listAccounts: () => [{ accountId: 0, telegramUserId: "u1", addedAt: "start" }],
        getAccountAttachmentId: () => "attachment",
      },
      baseUrl: "https://tools-uploads-filename-test.invalid",
      sourceAccountId: 0,
      sourceAttachmentId: "attachment",
    }) as never;

  it("a link expires in 5 minutes even though uploaded files live 15", async () => {
    const uploads = new UploadStore(15 * 60_000);
    const before = Date.now();
    const res = await linkTool.handler({ fileName: "a.pdf", size: 3 }, linkDeps(uploads));
    const out = res.structuredContent as { expiresAt: string };
    const ttl = Date.parse(out.expiresAt) - before;
    assert.ok(ttl > 4 * 60_000 && ttl <= 5 * 60_000 + 1000, `ttl ${ttl}`);
  });

  it("sha256 is optional and, when given, recorded with the link", async () => {
    const uploads = new UploadStore(15 * 60_000);
    const plain = await linkTool.handler({ fileName: "a.pdf", size: 3 }, linkDeps(uploads));
    assert.equal((plain.structuredContent as { sha256?: string }).sha256, undefined);
    const digest = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
    const pinned = await linkTool.handler({ fileName: "a.pdf", size: 3, sha256: digest }, linkDeps(uploads));
    const token = (pinned.structuredContent as { url: string }).url.split("/u/")[1] as string;
    assert.equal(uploads.peekLink(token)?.sha256, digest.toLowerCase());
  });
});
