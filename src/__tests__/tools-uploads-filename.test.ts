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

type StreamCall = { size: number; name: string; received: number; chunks: number };

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
    uploadStream: async (source: AsyncIterable<Uint8Array>, size: number, name: string) => {
      let received = 0;
      let chunks = 0;
      for await (const c of source) {
        received += c.byteLength;
        chunks++;
      }
      streamCalls.push({ size, name, received, chunks });
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
    assert.deepEqual(h.streamCalls, [{ size: 5, name: "a.txt", received: 5, chunks: 1 }]);
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
    const result = sendFileTool.onError?.(thrown) as { content: Array<{ text: string }>; isError: boolean };
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
    assert.match(out.curl, /^curl -fsS -T '.*report\.pdf.*' 'https:\/\/.*\/u\//);
    const token = out.url.split("/u/")[1] as string;
    const claimed = h.uploads.peekLink(token);
    assert.equal(claimed?.size, 1234);
    assert.equal(claimed?.accountId, 0);
    assert.equal(h.uploads.isAwaitingLink("u1", out.uploadId), true);
  });
});
