process.env.ISSUER ??= "https://private-download-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { DOWNLOAD_CHUNK_BYTES, DOWNLOAD_LIMITS, type DownloadMetadata, DownloadStore } from "../download-store.js";

const { config } = await import("../config.js");
const { OAuthProvider } = await import("../oauth.js");
const { createMyRoutes } = await import("../routes/my.js");
const { registerAllTools } = await import("../tool-registry.js");
const { READ_TOOLS } = await import("../tools/read.js");

import { securityHeaders } from "../middleware/security-headers.js";
import { templatePath } from "../telemetry/route-template.js";

const foundTool = READ_TOOLS.find((t) => t.name === "telegram-download-media");
assert.ok(foundTool);
const tool = foundTool;
const BYTES = Buffer.alloc(DOWNLOAD_CHUNK_BYTES * 2 + 781, 0x6f);
BYTES.write("OggS");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(switchDuringDownload = false) {
  let now = Date.now();
  const downloads = new DownloadStore(() => now);
  const accounts = [
    { accountId: 0, telegramUserId: "alice", addedAt: "start" },
    { accountId: 9, telegramUserId: "secondary", addedAt: "start" },
  ];
  let active = 0;
  let calls = 0;
  let connects = 0;
  let available = true;
  const sessions = {
    listAccounts: (owner: string) => (owner === "alice" ? accounts : []),
    getActiveAccountId: () => active,
    getAccountAttachmentId: () => "attachment",
    getSavedUserIds: () => ["alice", "bob"],
  };
  const telegram = {
    downloadMediaBounded: async (_chat: string, _id: number, options: { maxBytes: number; thumb?: number }) => {
      calls++;
      if (switchDuringDownload) active = 9;
      assert.equal(options.maxBytes, DOWNLOAD_LIMITS.fileBytes);
      return { buffer: BYTES, mimeType: "audio/ogg", isThumb: false, fileName: "../voice\u202e.ogg" };
    },
  };
  async function connect(owner: string) {
    const server = new McpServer({ name: "download-test", version: "0.0.0" });
    registerAllTools(server, [tool], {
      getTelegram: () => {
        if (!available) throw new Error("offline");
        return telegram as never;
      },
      requireConnection: async () => {
        connects++;
        return null;
      },
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
  const app = new Hono();
  app.use("*", securityHeaders);
  app.route(
    "/my",
    createMyRoutes({ sessions: sessions as never, uploads: {} as never, destructive: {} as never, downloads, oauth }),
  );
  const prepare = async (args = {}) => {
    const result = await client.callTool({
      name: tool.name,
      arguments: { chatId: "@chat", messageId: 101, file: true, ...args },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as unknown as DownloadMetadata & { url: string };
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
    calls: () => calls,
    connects: () => connects,
    setOffline: () => {
      available = false;
    },
    switchAccount: () => {
      active = 9;
    },
    removePrimary: () => {
      accounts.splice(0, 1);
    },
    expire: () => {
      now += DOWNLOAD_LIMITS.ttlMs;
    },
  };
}

describe("private download — actual MCP SDK + authenticated HTTP flow", () => {
  it("prepares once, reassembles chunks without another Telegram call, validates hash", async () => {
    const f = await setup();
    const meta = await f.prepare();
    assert.match(meta.url, /\/my\/download\/dl_[a-f0-9]{32}$/);
    assert.equal(meta.fileName, "voice.ogg");
    assert.equal(meta.size, BYTES.length);
    assert.equal(meta.sha256, createHash("sha256").update(BYTES).digest("hex"));
    f.setOffline(); // chunks are local; no connection check or Telegram service required
    f.switchAccount(); // the old snapshot must not silently fetch from the NEW account
    const directory = await mkdtemp(join(tmpdir(), "private-download-test-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const destination = join(directory, "voice.ogg.partial"); // not the remote filename
    const file = await open(destination, "wx", 0o600);
    cleanup.push(() => file.close());
    let offset = 0;
    for (;;) {
      const args = { chatId: "@chat", messageId: 101, downloadId: meta.downloadId, offset };
      const res = await f.client.callTool({ name: tool.name, arguments: args });
      assert.notEqual(res.isError, true, JSON.stringify(res));
      const chunk = res.structuredContent as { base64: string; eof: boolean; nextOffset: number };
      const retry = await f.client.callTool({ name: tool.name, arguments: args });
      assert.deepEqual(retry.structuredContent, res.structuredContent);
      const bytes = Buffer.from(chunk.base64, "base64");
      assert.ok(bytes.length <= DOWNLOAD_CHUNK_BYTES);
      assert.equal(chunk.nextOffset, offset + bytes.length);
      await file.write(bytes, 0, bytes.length, offset);
      if (chunk.eof) break;
      assert.ok(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    }
    const saved = await readFile(destination);
    assert.deepEqual(saved, BYTES);
    assert.equal(saved.length, meta.size);
    assert.equal(createHash("sha256").update(saved).digest("hex"), meta.sha256);
    assert.equal(f.calls(), 1);
    assert.equal(f.connects(), 1);
  });

  it("URL requires owner auth; cookie and Bearer work; no fallback from bogus Authorization", async () => {
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
    assert.equal(
      (await f.app.request(path, { headers: { Authorization: `Bearer ${f.stranger}`, Cookie: `tg_sid=${f.cookie}` } }))
        .status,
      404,
    );
    assert.equal((await f.app.request(path, { headers: { Authorization: `Bearer ${f.stranger}` } })).status, 404);
    for (const auth of ["Bearer bad", "Basic bad", "bearer bad"]) {
      assert.equal(
        (await f.app.request(path, { headers: { Authorization: auth, Cookie: `tg_sid=${f.cookie}` } })).status,
        401,
      );
    }
    const ownerHeaders: Record<string, string>[] = [
      { Authorization: `Bearer ${f.token}` },
      { Cookie: `tg_sid=${f.cookie}` },
    ];
    for (const headers of ownerHeaders) {
      const res = await f.app.request(path, { headers });
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), BYTES);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
      assert.equal(res.headers.get("content-security-policy"), "sandbox; default-src 'none'");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
    const head = await f.app.request(path, { method: "HEAD", headers: { Authorization: `Bearer ${f.token}` } });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get("content-length"), String(BYTES.length));
    f.oauth.revokeToken(f.token);
    assert.equal((await f.app.request(path, { headers: { Authorization: `Bearer ${f.token}` } })).status, 401);
    assert.equal(templatePath(path), "/my/download/:id");
  });

  it("another MCP owner cannot read chunks; wrong source and invalid offsets are rejected", async () => {
    const f = await setup();
    const meta = await f.prepare();
    const bob = await f.connect("bob");
    const args = { chatId: "@chat", messageId: 101, downloadId: meta.downloadId };
    assert.equal((await bob.callTool({ name: tool.name, arguments: args })).isError, true);
    for (const bad of [
      { chatId: "@other" },
      { messageId: 102 },
      { offset: -1 },
      { offset: 1.5 },
      { offset: BYTES.length + 1 },
    ]) {
      assert.equal((await f.client.callTool({ name: tool.name, arguments: { ...args, ...bad } })).isError, true);
    }
  });

  it("fixed TTL is not extended by reading; removing source account invalidates snapshots", async () => {
    const f = await setup();
    const meta = await f.prepare();
    assert.ok(f.downloads.read("alice", meta.downloadId));
    f.expire();
    assert.equal(f.downloads.read("alice", meta.downloadId), null);
    assert.equal(
      (await f.app.request(new URL(meta.url).pathname, { headers: { Authorization: `Bearer ${f.token}` } })).status,
      404,
    );
    const next = await f.prepare();
    f.removePrimary();
    assert.equal(f.downloads.read("alice", next.downloadId), null);
    assert.equal(
      (
        await f.client.callTool({
          name: tool.name,
          arguments: { chatId: "@chat", messageId: 101, downloadId: next.downloadId },
        })
      ).isError,
      true,
    );
  });

  it("switching accounts during IO does not relabel the source snapshot", async () => {
    const f = await setup(true);
    const meta = await f.prepare();
    assert.ok(f.downloads.read("alice", meta.downloadId));
    f.removePrimary();
    assert.equal(f.downloads.read("alice", meta.downloadId), null);
    assert.equal(f.calls(), 1);
  });

  it("file:true bypasses thumbnails and inline image base64; fails closed on old core", async () => {
    const store = new DownloadStore();
    let options: { thumb?: number } | undefined;
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
        downloadMediaBounded: async (_c: string, _m: number, o: { thumb?: number }) => {
          options = o;
          return { buffer: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", isThumb: false };
        },
      },
    };
    const res = await tool.handler({ chatId: "@chat", messageId: 101, file: true }, deps as never);
    assert.equal(options?.thumb, undefined);
    assert.ok(res.structuredContent?.downloadId);
    assert.equal(
      res.content.some((c) => c.type === "image"),
      false,
    );
    await assert.rejects(
      () => tool.handler({ chatId: "@chat", messageId: 101 }, { ...deps, telegram: {} } as never),
      /updated Telegram core/,
    );
  });
});
