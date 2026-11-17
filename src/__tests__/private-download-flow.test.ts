process.env.ISSUER ??= "https://private-download-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { DOWNLOAD_CHUNK_BYTES, DOWNLOAD_LIMITS, type DownloadMetadata, DownloadStore } from "../download-store.js";
import { UploadStore } from "../upload-store.js";

const { config } = await import("../config.js");
const { OAuthProvider } = await import("../oauth.js");
const { createMyRoutes } = await import("../routes/my.js");
const { createTransferRoutes } = await import("../routes/transfer.js");
const { registerAllTools } = await import("../tool-registry.js");
const { READ_TOOLS } = await import("../tools/read.js");

import { securityHeaders } from "../middleware/security-headers.js";
import { templatePath } from "../telemetry/route-template.js";

const foundTool = READ_TOOLS.find((t) => t.name === "telegram-download-media");
assert.ok(foundTool);
const tool = foundTool;
const BYTES = Buffer.alloc(DOWNLOAD_CHUNK_BYTES * 2 + 781, 0x6f);
BYTES.write("OggS");
for (let i = 0; i < BYTES.length; i += 997) BYTES[i] = i & 0xff;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Ticket = DownloadMetadata & { url: string; oneTimeUrl: string; chunkBytes: number };

async function setup() {
  let now = Date.now();
  const downloads = new DownloadStore(() => now);
  const accounts = [
    { accountId: 0, telegramUserId: "alice", addedAt: "start" },
    { accountId: 9, telegramUserId: "secondary", addedAt: "start" },
  ];
  let active = 0;
  const size = BYTES.length;
  let fileId = "document:1:2";
  const reads: Array<{ accountId: number; offset: number; length: number }> = [];
  const streams: Array<{ accountId: number; start: number }> = [];
  const sessionsFor: Array<{ owner: string; accountId: number }> = [];
  let available = true;
  const makeTelegram = (accountId: number) => ({
    isConnected: () => true,
    uploadStream: async () => {
      throw new Error("not used here");
    },
    getMediaInfo: async () => ({ kind: "document", fileId, size, mimeType: "audio/ogg", fileName: "../voice‮.ogg" }),
    openMedia: async () => ({
      info: { kind: "document", fileId, size, mimeType: "audio/ogg", fileName: "../voice‮.ogg" },
      readRange: async (offset: number, length: number) => {
        reads.push({ accountId, offset, length });
        return BYTES.subarray(offset, offset + length);
      },
      stream: async function* (start: number) {
        streams.push({ accountId, start });
        for (let i = start; i < BYTES.length; i += 50_000) yield BYTES.subarray(i, Math.min(i + 50_000, BYTES.length));
      },
    }),
    downloadMediaBounded: async () => {
      throw new Error("previews are not used by file:true");
    },
  });
  const telegrams = new Map([
    [0, makeTelegram(0)],
    [9, makeTelegram(9)],
  ]);
  const sessions = {
    listAccounts: (owner: string) => (owner === "alice" ? accounts : []),
    getActiveAccountId: () => active,
    getAccountAttachmentId: () => "attachment",
    getSavedUserIds: () => ["alice", "bob"],
    ensureAccountSession: async (owner: string, accountId: number) => {
      sessionsFor.push({ owner, accountId });
      return telegrams.get(accountId);
    },
  };
  async function connect(owner: string) {
    const server = new McpServer({ name: "download-test", version: "0.0.0" });
    registerAllTools(server, [tool], {
      getTelegram: () => {
        if (!available) throw new Error("offline");
        return telegrams.get(active) as never;
      },
      requireConnection: async () => null,
      downloads,
      userId: owner,
      sessions: sessions as never,
      baseUrl: config.issuer,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }
  const client = await connect("alice");
  const db = new Database(":memory:");
  cleanup.push(() => db.close());
  const oauth = new OAuthProvider({ issuer: config.issuer, db });
  const tokenFor = (userId: string) => {
    const redirectUri = "https://client.invalid/callback";
    const clientId = String(oauth.registerClient({ redirect_uris: [redirectUri] }).client_id);
    const verifier = "verifier";
    const code = oauth.createAuthCode({
      userId,
      clientId,
      redirectUri,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
    });
    const pair = oauth.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier });
    assert.ok(pair);
    return pair.access_token;
  };
  const token = tokenFor("alice");
  const stranger = tokenFor("bob");
  const cookie = oauth.createBrowserSession("alice", 600);
  const uploads = new UploadStore(15 * 60_000);
  const app = new Hono();
  app.use("*", securityHeaders);
  app.route(
    "/my",
    createMyRoutes({ sessions: sessions as never, uploads, destructive: {} as never, downloads, oauth }),
  );
  app.route("/", createTransferRoutes({ sessions: sessions as never, downloads, uploads }));
  const prepare = async (args = {}) => {
    const result = await client.callTool({
      name: tool.name,
      arguments: { chatId: "@chat", messageId: 101, file: true, ...args },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as unknown as Ticket;
  };
  return {
    downloads,
    client,
    connect,
    app,
    prepare,
    token,
    stranger,
    cookie,
    oauth,
    reads,
    streams,
    sessionsFor,
    setOffline: () => {
      available = false;
    },
    switchAccount: () => {
      active = 9;
    },
    removePrimary: () => {
      accounts.splice(0, 1);
    },
    changeMedia: () => {
      fileId = "document:99:2"; // replaced by a file of the same size
    },
    expire: () => {
      now += DOWNLOAD_LIMITS.ttlMs;
    },
  };
}

async function readAllChunks(f: Awaited<ReturnType<typeof setup>>, downloadId: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const args = { chatId: "@chat", messageId: 101, downloadId, offset };
    const res = await f.client.callTool({ name: tool.name, arguments: args });
    assert.notEqual(res.isError, true, JSON.stringify(res));
    const chunk = res.structuredContent as { base64: string; eof: boolean; nextOffset: number; offset: number };
    const bytes = Buffer.from(chunk.base64, "base64");
    assert.equal(chunk.offset, offset);
    assert.ok(bytes.length <= DOWNLOAD_CHUNK_BYTES);
    assert.equal(chunk.nextOffset, offset + bytes.length);
    parts.push(bytes);
    if (chunk.eof) break;
    offset = chunk.nextOffset;
  }
  return Buffer.concat(parts);
}

describe("private download — tickets, MCP chunks and HTTP streaming", () => {
  it("file:true returns a ticket without bytes or hash; chunks are read from the ticket's account", async () => {
    const f = await setup();
    const meta = await f.prepare();
    assert.match(meta.url, /\/my\/download\/dl_[a-f0-9]{32}$/);
    assert.match(meta.oneTimeUrl, /\/d\/[A-Za-z0-9_-]{22}$/);
    assert.equal(meta.fileName, "voice.ogg");
    assert.equal(meta.size, BYTES.length);
    assert.equal(meta.mimeType, "audio/ogg");
    assert.equal(meta.chunkBytes, DOWNLOAD_CHUNK_BYTES);
    assert.equal("sha256" in meta, false, "the server holds no bytes, so it cannot promise a hash");
    assert.equal(f.reads.length, 0, "preparing a ticket downloads nothing");

    f.setOffline(); // chunk reads connect the ticket's own account, not the active pool entry
    f.switchAccount(); // and must not silently read from the NEW active account
    const saved = await readAllChunks(f, meta.downloadId);
    assert.deepEqual(saved, BYTES);
    assert.ok(f.reads.every((r) => r.accountId === 0));
    assert.ok(f.reads.every((r) => r.offset % DOWNLOAD_CHUNK_BYTES === 0 && r.length === DOWNLOAD_CHUNK_BYTES));
    assert.ok(f.sessionsFor.every((s) => s.owner === "alice" && s.accountId === 0));

    const args = { chatId: "@chat", messageId: 101, downloadId: meta.downloadId, offset: DOWNLOAD_CHUNK_BYTES };
    const once = await f.client.callTool({ name: tool.name, arguments: args });
    const again = await f.client.callTool({ name: tool.name, arguments: args });
    assert.deepEqual(again.structuredContent, once.structuredContent, "same offset, same bytes");
  });

  it("asking again for the same message reuses the ticket with a fresh one-time link", async () => {
    const f = await setup();
    const first = await f.prepare();
    const second = await f.prepare();
    assert.equal(second.downloadId, first.downloadId);
    assert.equal(second.expiresAt, first.expiresAt, "reuse does not extend the ticket");
    assert.notEqual(second.oneTimeUrl, first.oneTimeUrl);
    const stale = await f.app.request(new URL(first.oneTimeUrl).pathname);
    assert.equal(stale.status, 404, "the previous one-time link stops working");
    const other = await f.prepare({ messageId: 102 });
    assert.notEqual(other.downloadId, first.downloadId);
  });

  it("session URL requires owner auth; cookie and Bearer stream from Telegram; Range is honoured", async () => {
    const f = await setup();
    const meta = await f.prepare();
    const path = new URL(meta.url).pathname;
    const noAuth = await f.app.request(path);
    assert.equal(noAuth.status, 401);
    assert.ok(noAuth.headers.get("www-authenticate"));
    assert.equal(noAuth.headers.get("cache-control"), "private, no-store");
    const browserSignIn = await f.app.request(path, { headers: { Accept: "text/html" } });
    assert.equal(browserSignIn.status, 401);
    assert.match(await browserSignIn.text(), /href="\/login"/);
    assert.equal((await f.app.request(path, { headers: { Cookie: "tg_user=alice" } })).status, 401);
    assert.equal((await f.app.request(path, { headers: { Authorization: `Bearer ${f.stranger}` } })).status, 404);
    for (const auth of ["Bearer bad", "Basic bad", "bearer bad"]) {
      assert.equal(
        (await f.app.request(path, { headers: { Authorization: auth, Cookie: `tg_sid=${f.cookie}` } })).status,
        401,
      );
    }
    const owners: Record<string, string>[] = [{ Authorization: `Bearer ${f.token}` }, { Cookie: `tg_sid=${f.cookie}` }];
    for (const headers of owners) {
      const res = await f.app.request(path, { headers });
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), BYTES);
      assert.equal(res.headers.get("content-length"), String(BYTES.length));
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment;.*voice\.ogg/);
      assert.equal(res.headers.get("content-security-policy"), "sandbox; default-src 'none'");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("accept-ranges"), "bytes");
    }
    const ranged = await f.app.request(path, {
      headers: { Authorization: `Bearer ${f.token}`, Range: "bytes=70000-70099" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 70000-70099/${BYTES.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), BYTES.subarray(70000, 70100));
    assert.equal(f.streams.at(-1)?.start, 70000);
    const tail = await f.app.request(path, { headers: { Authorization: `Bearer ${f.token}`, Range: "bytes=-10" } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), BYTES.subarray(BYTES.length - 10));
    const beyond = await f.app.request(path, {
      headers: { Authorization: `Bearer ${f.token}`, Range: `bytes=${BYTES.length}-` },
    });
    assert.equal(beyond.status, 416);
    const head = await f.app.request(path, { method: "HEAD", headers: { Authorization: `Bearer ${f.token}` } });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get("content-length"), String(BYTES.length));
    f.oauth.revokeToken(f.token);
    assert.equal((await f.app.request(path, { headers: { Authorization: `Bearer ${f.token}` } })).status, 401);
    assert.equal(templatePath(path), "/my/download/:id");
  });

  it("one-time link works without auth exactly once; HEAD is refused and reveals nothing", async () => {
    const f = await setup();
    const meta = await f.prepare();
    const path = new URL(meta.oneTimeUrl).pathname;
    const head = await f.app.request(path, { method: "HEAD" });
    assert.equal(head.status, 405);
    assert.equal(head.headers.get("allow"), "GET");
    assert.equal(head.headers.get("content-length"), null);
    assert.equal(head.headers.get("content-disposition"), null);
    const res = await f.app.request(path);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), BYTES);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.ok(
      f.sessionsFor.every((s) => s.owner === "alice" && s.accountId === 0),
      "bound to owner + account",
    );
    const replay = await f.app.request(path);
    assert.equal(replay.status, 404);
    assert.match(((await replay.json()) as { error: string }).error, /DOWNLOAD_NOT_FOUND/);
    assert.equal((await f.app.request("/d/AAAAAAAAAAAAAAAAAAAAAA")).status, 404);
  });

  it("one-time link dies with expiry and with the source account", async () => {
    const f = await setup();
    const meta = await f.prepare();
    f.expire();
    assert.equal((await f.app.request(new URL(meta.oneTimeUrl).pathname)).status, 404);
    const next = await f.prepare();
    f.removePrimary();
    assert.equal((await f.app.request(new URL(next.oneTimeUrl).pathname)).status, 404);
    assert.equal(f.downloads.get("alice", next.downloadId), null);
  });

  it("another owner cannot read chunks; wrong source and invalid offsets get coded errors", async () => {
    const f = await setup();
    const meta = await f.prepare();
    const bob = await f.connect("bob");
    const args = { chatId: "@chat", messageId: 101, downloadId: meta.downloadId };
    const foreign = await bob.callTool({ name: tool.name, arguments: args });
    assert.equal(foreign.isError, true);
    assert.match(JSON.stringify(foreign.content), /\[DOWNLOAD_NOT_FOUND\]/);
    for (const bad of [{ chatId: "@other" }, { messageId: 102 }]) {
      const res = await f.client.callTool({ name: tool.name, arguments: { ...args, ...bad } });
      assert.match(JSON.stringify(res.content), /\[DOWNLOAD_NOT_FOUND\]/);
    }
    for (const offset of [1000, BYTES.length + DOWNLOAD_CHUNK_BYTES]) {
      const res = await f.client.callTool({ name: tool.name, arguments: { ...args, offset } });
      assert.equal(res.isError, true);
      assert.match(JSON.stringify(res.content), /\[INVALID_RANGE\]/);
    }
    for (const offset of [-1, 1.5]) {
      assert.equal((await f.client.callTool({ name: tool.name, arguments: { ...args, offset } })).isError, true);
    }
  });

  it("fixed TTL; removing the source account or changing the media invalidates reads", async () => {
    const f = await setup();
    const meta = await f.prepare();
    assert.ok(f.downloads.get("alice", meta.downloadId));
    f.expire();
    assert.equal(f.downloads.get("alice", meta.downloadId), null);
    assert.equal(
      (await f.app.request(new URL(meta.url).pathname, { headers: { Authorization: `Bearer ${f.token}` } })).status,
      404,
    );
    const next = await f.prepare();
    f.changeMedia();
    const changed = await f.client.callTool({
      name: tool.name,
      arguments: { chatId: "@chat", messageId: 101, downloadId: next.downloadId },
    });
    assert.match(JSON.stringify(changed.content), /\[MEDIA_CHANGED\]/);
    const viaHttp = await f.app.request(new URL(next.url).pathname, {
      headers: { Authorization: `Bearer ${f.token}` },
    });
    assert.equal(viaHttp.status, 410);
    f.removePrimary();
    assert.equal(f.downloads.get("alice", next.downloadId), null);
  });

  it("file:true skips previews; an old core fails closed with a code", async () => {
    const store = new DownloadStore();
    const deps = {
      downloads: store,
      userId: "alice",
      sourceAccountId: 0,
      sourceAttachmentId: "attachment",
      baseUrl: config.issuer,
      sessions: {
        getAccountAttachmentId: () => "attachment",
        listAccounts: () => [{ accountId: 0, telegramUserId: "alice", addedAt: "start" }],
      },
      telegram: {
        openMedia: async () => ({}),
        uploadStream: async () => ({}),
        getMediaInfo: async () => ({ kind: "photo", fileId: "photo:1:2:y", size: 3, mimeType: "image/jpeg" }),
        downloadMediaBounded: async () => {
          throw new Error("file:true must not download a preview");
        },
      },
    };
    const res = await tool.handler({ chatId: "@chat", messageId: 101, file: true }, deps as never);
    assert.ok(res.structuredContent?.downloadId);
    assert.equal(
      res.content.some((c) => c.type === "image"),
      false,
    );
    await assert.rejects(
      () => tool.handler({ chatId: "@chat", messageId: 101 }, { ...deps, telegram: {} } as never),
      (e: Error & { code?: string }) => e.code === "SERVER_MISCONFIGURED",
    );
  });
});
