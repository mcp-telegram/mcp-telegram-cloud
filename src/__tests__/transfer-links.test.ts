process.env.ISSUER ??= "https://transfer-links-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { DownloadStore } = await import("../download-store.js");
const { MediaQueue } = await import("../media-queue.js");
const { UploadStore } = await import("../upload-store.js");
const { createTransferRoutes, parseRange, requestBodyLimit } = await import("../routes/transfer.js");
const { mediaTimeouts: transferTimeouts } = await import("../media-queue.js");
const { Hono } = await import("hono");

function setup(opts: { failUpload?: Error } = {}) {
  const uploads = new UploadStore(15 * 60_000);
  const streamed: Array<{ owner: string; accountId: number; size: number; name: string; bytes: Buffer }> = [];
  const sessions = {
    listAccounts: () => [{ accountId: 0, telegramUserId: "alice", addedAt: "start" }],
    getAccountAttachmentId: () => "attachment",
    ensureAccountSession: async (owner: string, accountId: number) => ({
      isConnected: () => true,
      openMedia: async () => ({}),
      uploadStream: async (source: AsyncIterable<Uint8Array>, size: number, name: string) => {
        const parts: Uint8Array[] = [];
        for await (const c of source) parts.push(c);
        const bytes = Buffer.concat(parts);
        if (opts.failUpload) throw opts.failUpload;
        if (bytes.length !== size) {
          throw Object.assign(new Error(`Received ${bytes.length} bytes, declared ${size}`), {
            name: "TelegramMediaError",
            code: "UPLOAD_SIZE_MISMATCH",
          });
        }
        streamed.push({ owner, accountId, size, name, bytes });
        return { kind: "uploaded-file", fileName: name, size, inputFile: {}, mimeType: "application/pdf" };
      },
    }),
  };
  const app = new Hono();
  app.use("*", requestBodyLimit);
  app.route("/", createTransferRoutes({ sessions: sessions as never, downloads: new DownloadStore(), uploads }));
  const link = (size: number, accountId = 3) => {
    const l = uploads.createLink("alice", { accountId, canUse: () => true }, "report.pdf", size);
    assert.ok(!("error" in l));
    return l;
  };
  return { app, uploads, streamed, link };
}

const put = (
  app: { request: (p: string, i: RequestInit) => Response | Promise<Response> },
  token: string,
  body: Buffer,
  init: RequestInit = {},
) => app.request(`/u/${token}`, { method: "PUT", body, headers: { "content-length": String(body.length) }, ...init });

describe("upload link PUT /u/<token>", () => {
  it("streams the body into Telegram with the link's owner and account, then the uploadId is ready", async () => {
    const f = setup();
    const l = f.link(11);
    const res = await put(f.app, l.token, Buffer.from("hello world"));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { uploadId: string; size: number; fileName: string };
    assert.equal(json.uploadId, l.uploadId);
    assert.equal(json.fileName, "report.pdf");
    assert.equal(f.streamed.length, 1);
    assert.deepEqual(
      { ...f.streamed[0], bytes: f.streamed[0]?.bytes.toString() },
      { owner: "alice", accountId: 3, size: 11, name: "report.pdf", bytes: "hello world" },
    );
    const ready = f.uploads.resolve("alice", l.uploadId);
    assert.equal(ready?.accountId, 3);
    assert.equal(ready?.file.size, 11);
  });

  it("is single use", async () => {
    const f = setup();
    const l = f.link(3);
    assert.equal((await put(f.app, l.token, Buffer.from("abc"))).status, 200);
    const again = await put(f.app, l.token, Buffer.from("abc"));
    assert.equal(again.status, 404);
    assert.equal(((await again.json()) as { error: string }).error, "UPLOAD_NOT_FOUND");
    assert.equal(f.streamed.length, 1);
  });

  it("refuses a Content-Length that differs from the declared size and burns the link", async () => {
    const f = setup();
    const l = f.link(5);
    const wrong = await put(f.app, l.token, Buffer.from("abc"));
    assert.equal(wrong.status, 400);
    assert.equal(((await wrong.json()) as { error: string }).error, "UPLOAD_SIZE_MISMATCH");
    assert.equal(f.streamed.length, 0);
    assert.equal((await put(f.app, l.token, Buffer.from("abcde"))).status, 404, "a presented token is used up");
  });

  it("only a busy server leaves the link alive", async () => {
    const { transferQueue } = await import("../media-queue.js");
    const f = setup();
    const l = f.link(3);
    const held = [await transferQueue.acquire("alice"), await transferQueue.acquire("alice")];
    try {
      const busy = await put(f.app, l.token, Buffer.from("abc"));
      assert.equal(busy.status, 429);
    } finally {
      for (const release of held) release();
    }
    assert.equal((await put(f.app, l.token, Buffer.from("abc"))).status, 200, "retry after busy works");
  });

  it("requires Content-Length", async () => {
    const f = setup();
    const l = f.link(3);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const res = await f.app.request(`/u/${l.token}`, { method: "PUT", body: stream, duplex: "half" } as RequestInit);
    assert.equal(res.status, 411);
    assert.equal((await put(f.app, l.token, Buffer.from("abc"))).status, 404, "the token is used up");
  });

  it("a body that ends short fails with a code and burns the link", async () => {
    const f = setup({
      failUpload: Object.assign(new Error("Received 2 bytes but the declared size is 3"), {
        name: "TelegramMediaError",
        code: "UPLOAD_SIZE_MISMATCH",
      }),
    });
    const l = f.link(3);
    const res = await put(f.app, l.token, Buffer.from("abc"));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "UPLOAD_SIZE_MISMATCH");
    assert.equal(f.uploads.resolve("alice", l.uploadId), null);
    assert.equal((await put(f.app, l.token, Buffer.from("abc"))).status, 404);
  });

  it("POST with a raw body works too; unknown tokens are 404", async () => {
    const f = setup();
    const l = f.link(2);
    assert.equal((await put(f.app, l.token, Buffer.from("ok"), { method: "POST" })).status, 200);
    assert.equal((await put(f.app, "AAAAAAAAAAAAAAAAAAAAAA", Buffer.from("ok"))).status, 404);
  });
});

describe("request body policy", () => {
  const appWith = () => {
    const app = new Hono();
    app.use("*", requestBodyLimit);
    app.post("/mcp", async (c) => c.text(String((await c.req.arrayBuffer()).byteLength)));
    app.post("/my/upload", (c) => c.text("ok"));
    app.put("/u/:token", (c) => c.text("ok"));
    return app;
  };
  /**
   * A 100-chunk body that counts pulls. Bun primes one chunk when the Request is
   * built, so "unread" means at most a couple of pulls, not all 100.
   */
  const watched = (chunk: number) => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(chunk));
        if (pulls >= 100) c.close();
      },
    });
    return { stream, pulled: () => pulls > 2 };
  };

  it("rejects an oversize Content-Length from the header without reading the body", async () => {
    const body = watched(10);
    const res = await appWith().request("/mcp", {
      method: "POST",
      body: body.stream,
      headers: { "content-length": String(5 * 1024 * 1024) },
      duplex: "half",
    } as RequestInit);
    assert.equal(res.status, 413);
    assert.equal(body.pulled(), false);
  });

  it("caps a body without Content-Length at 4 MiB instead of 128 MiB", async () => {
    const chunked = (size: number) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let sent = 0; sent < size; sent += 1024 * 1024)
            c.enqueue(new Uint8Array(Math.min(1024 * 1024, size - sent)));
          c.close();
        },
      });
    const app = appWith();
    const big = await app.request("/mcp", {
      method: "POST",
      body: chunked(5 * 1024 * 1024),
      duplex: "half",
    } as RequestInit);
    assert.equal(big.status, 413);
    const small = await app.request("/mcp", { method: "POST", body: chunked(1024), duplex: "half" } as RequestInit);
    assert.equal(await small.text(), "1024");
  });

  it("/my/upload needs Content-Length; upload links are never read by the middleware", async () => {
    const app = appWith();
    const noLength = watched(10);
    const res = await app.request("/my/upload", {
      method: "POST",
      body: noLength.stream,
      duplex: "half",
    } as RequestInit);
    assert.equal(res.status, 411);
    assert.equal(noLength.pulled(), false);
    const link = watched(10);
    const huge = { "content-length": String(200 * 1024 * 1024) };
    const put = await app.request("/u/abc", {
      method: "PUT",
      body: link.stream,
      headers: huge,
      duplex: "half",
    } as RequestInit);
    assert.equal(put.status, 200);
    assert.equal(link.pulled(), false, "the /u/ body reaches the route unread");
  });
});

/** A ticket-backed app whose Telegram stream the test controls. */
function downloadSetup(telegram: () => Promise<unknown>, canRead: () => boolean = () => true) {
  const downloads = new DownloadStore();
  const marked: unknown[] = [];
  const sessions = {
    listAccounts: () => [{ accountId: 0, telegramUserId: "alice", addedAt: "start" }],
    getAccountAttachmentId: () => "attachment",
    ensureAccountSession: telegram,
    markUnhealthy: (_owner: string, target: { expected: unknown }) => marked.push(target.expected),
  };
  const app = new Hono();
  app.route("/", createTransferRoutes({ sessions: sessions as never, downloads, uploads: new UploadStore(60_000) }));
  const issue = () =>
    downloads.issue(
      "alice",
      { chatId: "@c", messageId: 1, accountId: 0, canRead },
      { fileId: "document:1:2", size: 1024, mimeType: "application/zip", fileName: "a.zip" },
    ).oneTimeToken;
  return { app, issue, marked };
}

describe("download streaming responses", () => {
  it("an error before streaming carries no file headers", async () => {
    const f = downloadSetup(async () => {
      throw new Error("connect failed");
    });
    const res = await f.app.request(`/d/${f.issue()}`, { headers: { Range: "bytes=0-9" } });
    assert.equal(res.status, 503);
    const body = await res.text();
    const length = res.headers.get("content-length");
    assert.ok(length === null || Number(length) === Buffer.byteLength(body), `Content-Length ${length}`);
    assert.equal(res.headers.get("content-range"), null);
    assert.equal(res.headers.get("content-disposition"), null);
    assert.match(res.headers.get("content-type") ?? "", /json/);
  });

  it("keeps the concurrency slot until the pending Telegram read settles after an abort", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => {
      unblock = r;
    });
    const f = downloadSetup(async () => ({
      isConnected: () => true,
      openMedia: async () => ({
        info: { fileId: "document:1:2", size: 1024 },
        stream: async function* () {
          yield new Uint8Array(512);
          await blocked;
          yield new Uint8Array(512);
        },
      }),
      uploadStream: async () => ({}),
    }));
    const { transferQueue } = await import("../media-queue.js");
    const baseline = transferQueue.stats().total;
    const res = await f.app.request(`/d/${f.issue()}`);
    assert.equal(res.status, 200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    assert.equal((await reader.read()).value?.length, 512);
    await new Promise((r) => setTimeout(r, 10)); // let the next pull start the blocked read
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(transferQueue.stats().total, baseline + 1, "slot held while Telegram is still answering");
    unblock();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(transferQueue.stats().total, baseline, "slot released once the read settled");
  });
});

describe("download slots are bounded by time", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function withTimeouts<T>(over: Partial<typeof transferTimeouts>, fn: () => Promise<T>): Promise<T> {
    const saved = { ...transferTimeouts };
    Object.assign(transferTimeouts, over);
    try {
      return await fn();
    } finally {
      Object.assign(transferTimeouts, saved);
    }
  }
  const hungLookup = () =>
    downloadSetup(async () => ({
      isConnected: () => true,
      uploadStream: async () => ({}),
      openMedia: () => new Promise(() => {}), // Telegram never answers
    }));

  it("a hung file lookup times out and frees the slot", async () => {
    const { transferQueue } = await import("../media-queue.js");
    await withTimeouts({ lookupMs: 30, backstopMs: 60 }, async () => {
      const f = hungLookup();
      const baseline = transferQueue.stats().total;
      const started = Date.now();
      const res = await f.app.request(`/d/${f.issue()}`);
      assert.ok(Date.now() - started < 1000, "answered instead of hanging");
      assert.equal(((await res.json()) as { error: string }).error, "DOWNLOAD_FAILED");
      assert.equal(f.marked.length, 1, "the account's wedged client is marked for revalidation");
      await sleep(120);
      assert.equal(transferQueue.stats().total, baseline, "slot freed by the backstop");
    });
  });

  it("a client that disconnects during the lookup gets no stream and frees the slot", async () => {
    const { transferQueue } = await import("../media-queue.js");
    await withTimeouts({ lookupMs: 60_000, backstopMs: 60 }, async () => {
      const f = hungLookup();
      const baseline = transferQueue.stats().total;
      const client = new AbortController();
      setTimeout(() => client.abort(), 20);
      const res = await f.app.request(`/d/${f.issue()}`, { signal: client.signal });
      assert.notEqual(res.status, 200);
      await sleep(120);
      assert.equal(transferQueue.stats().total, baseline);
    });
  });

  it("after the deadline answered, the slot stays held until Telegram's part requests settle", async () => {
    const { transferQueue } = await import("../media-queue.js");
    await withTimeouts({ totalMs: 30, backstopMs: 60_000 }, async () => {
      let partsSettled!: () => void;
      const parts = new Promise<void>((r) => {
        partsSettled = r;
      });
      const uploads = new UploadStore(60_000);
      const sessions = {
        listAccounts: () => [{ accountId: 0, telegramUserId: "alice", addedAt: "start" }],
        getAccountAttachmentId: () => "attachment",
        ensureAccountSession: async () => ({
          isConnected: () => true,
          openMedia: async () => ({}),
          // Core's uploadStream only rejects once its in-flight parts have settled.
          uploadStream: async () => {
            await parts;
            throw new Error("aborted after parts settled");
          },
        }),
      };
      const app = new Hono();
      app.route("/", createTransferRoutes({ sessions: sessions as never, downloads: new DownloadStore(), uploads }));
      const link = uploads.createLink("alice", { accountId: 0, canUse: () => true }, "a.bin", 3);
      assert.ok(!("error" in link));
      const baseline = transferQueue.stats().total;
      const res = await app.request(`/u/${link.token}`, {
        method: "PUT",
        body: "abc",
        headers: { "content-length": "3" },
      });
      assert.equal(((await res.json()) as { error: string }).error, "UPLOAD_FAILED");
      await sleep(30);
      assert.equal(transferQueue.stats().total, baseline + 1, "parts still in flight hold the slot");
      partsSettled();
      await sleep(20);
      assert.equal(transferQueue.stats().total, baseline);
    });
  });

  it("an upload that stalls past the limit is answered and frees its slot", async () => {
    const { transferQueue } = await import("../media-queue.js");
    await withTimeouts({ totalMs: 40, backstopMs: 60 }, async () => {
      const uploads = new UploadStore(60_000);
      const sessions = {
        listAccounts: () => [{ accountId: 0, telegramUserId: "alice", addedAt: "start" }],
        getAccountAttachmentId: () => "attachment",
        ensureAccountSession: async () => ({
          isConnected: () => true,
          openMedia: async () => ({}),
          uploadStream: () => new Promise(() => {}), // body or Telegram never finishes
        }),
      };
      const app = new Hono();
      app.route("/", createTransferRoutes({ sessions: sessions as never, downloads: new DownloadStore(), uploads }));
      const link = uploads.createLink("alice", { accountId: 0, canUse: () => true }, "a.bin", 3);
      assert.ok(!("error" in link));
      const baseline = transferQueue.stats().total;
      const started = Date.now();
      const res = await app.request(`/u/${link.token}`, {
        method: "PUT",
        body: "abc",
        headers: { "content-length": "3" },
      });
      assert.ok(Date.now() - started < 1000, "answered at the limit");
      assert.equal(((await res.json()) as { error: string }).error, "UPLOAD_FAILED");
      await sleep(120);
      assert.equal(transferQueue.stats().total, baseline, "slot freed by the backstop");
    });
  });

  it("a Telegram read that stalls mid-stream ends the stream and frees the slot", async () => {
    const { transferQueue } = await import("../media-queue.js");
    await withTimeouts({ chunkMs: 30, backstopMs: 60 }, async () => {
      const f = downloadSetup(async () => ({
        isConnected: () => true,
        uploadStream: async () => ({}),
        openMedia: async () => ({
          info: { fileId: "document:1:2", size: 1024 },
          stream: async function* () {
            yield new Uint8Array(512);
            await new Promise(() => {}); // the next GetFile never answers
          },
        }),
      }));
      const baseline = transferQueue.stats().total;
      const res = await f.app.request(`/d/${f.issue()}`);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      assert.equal((await reader.read()).value?.length, 512);
      await assert.rejects(() => reader.read(), /did not answer/);
      await sleep(120);
      assert.equal(transferQueue.stats().total, baseline, "slot freed by the backstop");
    });
  });

  it("the account binding is re-checked before every chunk of an HTTP download", async () => {
    let attached = true;
    const f = downloadSetup(
      async () => ({
        isConnected: () => true,
        uploadStream: async () => ({}),
        openMedia: async () => ({
          info: { fileId: "document:1:2", size: 1024 },
          stream: async function* () {
            yield new Uint8Array(512);
            attached = false; // detached while the second chunk was read
            yield new Uint8Array(512);
          },
        }),
      }),
      () => attached,
    );
    const res = await f.app.request(`/d/${f.issue()}`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    assert.equal((await reader.read()).value?.length, 512);
    await assert.rejects(() => reader.read(), /no longer attached/);
  });

  it("an upload whose account was detached meanwhile is not registered", async () => {
    const uploads = new UploadStore(60_000);
    let attached = true;
    const sessions = {
      listAccounts: () => [{ accountId: 0, telegramUserId: "alice", addedAt: "start" }],
      getAccountAttachmentId: () => "attachment",
      ensureAccountSession: async () => ({
        isConnected: () => true,
        openMedia: async () => ({}),
        uploadStream: async (source: AsyncIterable<Uint8Array>, size: number, fileName: string) => {
          for await (const _ of source) attached = false;
          return { kind: "uploaded-file", size, fileName, inputFile: {} };
        },
      }),
    };
    const app = new Hono();
    app.route("/", createTransferRoutes({ sessions: sessions as never, downloads: new DownloadStore(), uploads }));
    const link = uploads.createLink("alice", { accountId: 0, canUse: () => attached }, "a.bin", 3);
    assert.ok(!("error" in link));
    const res = await app.request(`/u/${link.token}`, {
      method: "PUT",
      body: "abc",
      headers: { "content-length": "3" },
    });
    assert.equal(((await res.json()) as { error: string }).error, "ACCOUNT_UNAVAILABLE");
    assert.equal(uploads.resolve("alice", link.uploadId), null);
  });

  it("a client that disconnects under backpressure frees the slot at once", async () => {
    const { transferQueue } = await import("../media-queue.js");
    const f = downloadSetup(async () => ({
      isConnected: () => true,
      uploadStream: async () => ({}),
      openMedia: async () => ({
        info: { fileId: "document:1:2", size: 1024 },
        stream: async function* () {
          for (;;) yield new Uint8Array(8);
        },
      }),
    }));
    const baseline = transferQueue.stats().total;
    const client = new AbortController();
    const res = await f.app.request(`/d/${f.issue()}`, { signal: client.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // then stop reading: no pull() is pending
    await sleep(20);
    assert.equal(transferQueue.stats().total, baseline + 1);
    client.abort();
    await sleep(20);
    assert.equal(transferQueue.stats().total, baseline, "freed without waiting for the 1 h limit");
    await assert.rejects(async () => {
      for (;;) if ((await reader.read()).done) break;
    }, /closed the connection/);
  });

  it("the total limit ends a stream whose client stopped reading", async () => {
    const { transferQueue } = await import("../media-queue.js");
    await withTimeouts({ totalMs: 50 }, async () => {
      const f = downloadSetup(async () => ({
        isConnected: () => true,
        uploadStream: async () => ({}),
        openMedia: async () => ({
          info: { fileId: "document:1:2", size: 1024 },
          stream: async function* () {
            for (;;) yield new Uint8Array(8);
          },
        }),
      }));
      const baseline = transferQueue.stats().total;
      const res = await f.app.request(`/d/${f.issue()}`);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // then stop reading: backpressure, no pull() running
      assert.equal(transferQueue.stats().total, baseline + 1);
      await sleep(120);
      assert.equal(transferQueue.stats().total, baseline, "slot freed at the limit");
      await assert.rejects(async () => {
        for (;;) if ((await reader.read()).done) break;
      }, /time limit/);
    });
  });
});

describe("capability tokens stay out of logs and telemetry", () => {
  it("masks /d/ and /u/ tokens of every shape", async () => {
    const { templatePath } = await import("../telemetry/route-template.js");
    for (const token of ["abcdefghijklmnopqrstuv", "abc_def-ghi_jkl-mnopqr", "AAAAAAAAAAAAAAAAAAAAAA", "x"]) {
      assert.equal(templatePath(`/d/${token}`), "/d/:token");
      assert.equal(templatePath(`/u/${token}`), "/u/:token");
    }
  });

  it("access log, rate limiter and metrics never see a full token", async () => {
    const { config } = await import("../config.js");
    const { logger } = await import("../logger.js");
    const { accessLog } = await import("../middleware/access-log.js");
    const { snapshot } = await import("../telemetry/metrics.js");
    const { getRecentErrors } = await import("../telemetry/error-buffer.js");
    const captured: string[] = [];
    const saved = { ...logger };
    const savedConsole = { log: console.log, error: console.error, warn: console.warn };
    const savedLimit = config.transferLinkRateLimit;
    config.transferLinkRateLimit = 2; // read when the routes are built
    const record =
      (orig: (...a: never[]) => unknown) =>
      (...args: unknown[]) => {
        captured.push(JSON.stringify(args));
        return (orig as (...a: unknown[]) => unknown)(...args);
      };
    for (const level of ["info", "warn", "error"] as const) {
      (logger as Record<string, unknown>)[level] = record(saved[level] as never);
    }
    console.log = record(savedConsole.log as never) as typeof console.log;
    console.error = record(savedConsole.error as never) as typeof console.error;
    console.warn = record(savedConsole.warn as never) as typeof console.warn;
    const tokens = ["noDigitsAtAllInThisTok", "has_underscore-andDash", "Zz9_yY8-xX7_wW6-vV5_uU"];
    try {
      const f = downloadSetup(async () => {
        throw new Error("offline");
      });
      const app = new Hono();
      app.use("*", accessLog);
      app.route("/", f.app);
      const real = f.issue();
      tokens.push(real);
      for (const t of tokens) {
        await app.request(`/d/${t}`);
        await app.request(`/u/${t}`, { method: "PUT", body: "x", headers: { "content-length": "1" } });
      }
    } finally {
      Object.assign(logger, saved);
      Object.assign(console, savedConsole);
      config.transferLinkRateLimit = savedLimit;
    }
    const everything = [...captured, JSON.stringify(snapshot()), JSON.stringify(getRecentErrors())].join("\n");
    assert.ok(
      captured.some((line) => line.includes("rate-limit")),
      "the limiter did log",
    );
    assert.ok(
      captured.some((line) => line.includes("/d/:token")),
      "the access log did log",
    );
    for (const t of tokens) assert.equal(everything.includes(t), false, `token ${t} leaked`);
  });
});

describe("Range parsing", () => {
  it("handles single ranges, suffixes and unsatisfiable starts", () => {
    assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange("bytes=990-5000", 1000), { start: 990, end: 999 });
    assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
    assert.equal(parseRange("bytes=0-1,5-6", 1000), null, "multi-range is served in full");
    assert.equal(parseRange(undefined, 1000), null);
    assert.equal(parseRange("items=0-1", 1000), null);
  });
});

describe("MediaQueue", () => {
  it("waits for a slot instead of failing, per user and per server", async () => {
    const q = new MediaQueue({ perUser: 1, total: 2, waitMs: 1000 });
    const order: string[] = [];
    const job = (name: string, owner: string, ms: number) =>
      q.run(owner, async () => {
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end ${name}`);
      });
    await Promise.all([job("a1", "a", 20), job("a2", "a", 1), job("b1", "b", 5)]);
    assert.deepEqual(order.slice(0, 2).sort(), ["start a1", "start b1"], "b is not blocked behind a's queue");
    assert.ok(order.indexOf("start a2") > order.indexOf("end a1"), "a2 waited for a1");
    assert.deepEqual(q.stats(), { total: 0, waiting: 0 });
  });

  it("gives up after waitMs with a retryable busy code", async () => {
    const q = new MediaQueue({ perUser: 1, total: 8, waitMs: 20 });
    const release = await q.acquire("a");
    await assert.rejects(
      () => q.acquire("a"),
      (e: Error & { code?: string; retryAfterMs?: number }) => e.code === "DOWNLOAD_BUSY" && e.retryAfterMs === 3000,
    );
    await assert.rejects(() => q.acquire("a", { wait: false }), { code: "DOWNLOAD_BUSY" } as object);
    release();
    release(); // idempotent
    (await q.acquire("a"))();
    assert.deepEqual(q.stats(), { total: 0, waiting: 0 });
  });
});
