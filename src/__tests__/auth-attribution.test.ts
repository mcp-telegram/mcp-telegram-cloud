/**
 * A session is revoked only on positive evidence from Telegram, attributed to the client
 * that raised it. Text that merely contains AUTH_KEY_* (a remote URL, a chat title, our
 * own wrapped message) must never revoke anything, and a revocation raised by another
 * account's client (a download ticket, an upload link) must never hit the caller's
 * active session.
 */
process.env.ISSUER ??= "https://auth-attribution-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const { registerAllTools } = await import("../tool-registry.js");
const { TOOLS } = await import("../tools.js");
const { DownloadStore } = await import("../download-store.js");
const { UploadStore } = await import("../upload-store.js");
const { createTransferRoutes } = await import("../routes/transfer.js");
const { Hono } = await import("hono");

const rpcAuthError = () =>
  Object.assign(new Error("401: AUTH_KEY_UNREGISTERED (caused by upload.GetFile)"), {
    errorMessage: "AUTH_KEY_UNREGISTERED",
    code: 401,
  });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function connect(
  tools: Parameters<typeof registerAllTools>[1],
  opts: Partial<Parameters<typeof registerAllTools>[2]> & { telegram: unknown },
) {
  const revoked: unknown[] = [];
  const server = new McpServer({ name: "auth-attribution", version: "0.0.0" });
  registerAllTools(server, tools, {
    getTelegram: () => opts.telegram as never,
    requireConnection: async () => null,
    onSessionRevoked: async (client) => {
      revoked.push(client);
    },
    userId: "alice",
    ...opts,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, revoked };
}

const text = (res: { content: unknown }) => JSON.stringify(res.content);

describe("registry: only genuine Telegram auth errors revoke", () => {
  const throwing = (error: () => unknown) => ({
    name: "test-throw",
    description: "throws",
    inputSchema: { x: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async () => {
      throw error();
    },
  });

  it("text that mentions AUTH_KEY_UNREGISTERED does not revoke the session", async () => {
    const f = await connect([throwing(() => new Error('Multiple chats match "AUTH_KEY_UNREGISTERED".'))], {
      telegram: { id: "primary" },
    });
    const res = await f.client.callTool({ name: "test-throw", arguments: {} });
    assert.equal(res.isError, true);
    assert.deepEqual(f.revoked, []);
  });

  it("a genuine RPC auth error revokes the call's own client once getMe confirms it", async () => {
    const primary = {
      id: "primary",
      getMe: async () => {
        throw rpcAuthError();
      },
    };
    const f = await connect([throwing(rpcAuthError)], { telegram: primary });
    await f.client.callTool({ name: "test-throw", arguments: {} });
    assert.deepEqual(f.revoked, [primary]);
  });

  it("any tool: an auth error the main connection does not confirm revokes nothing", async () => {
    const { config } = await import("../config.js");
    const saved = config.telegramConnectTimeoutMs;
    config.telegramConnectTimeoutMs = 30;
    try {
      // e.g. telegram-get-profile-photo: the photo comes from a file DC's exported sender.
      for (const getMe of [async () => ({ id: "1" }), () => new Promise(() => {})]) {
        const primary = { id: "primary", getMe };
        const f = await connect([throwing(rpcAuthError)], { telegram: primary });
        const started = Date.now();
        const res = await f.client.callTool({ name: "test-throw", arguments: {} });
        assert.ok(Date.now() - started < 2000, "a hung getMe is cut at its deadline");
        assert.equal(res.isError, true);
        assert.match(text(res as never), /\[ACCOUNT_UNAVAILABLE retryable retryAfterMs=3000\]/);
        assert.deepEqual(f.revoked, []);
      }
    } finally {
      config.telegramConnectTimeoutMs = saved;
    }
  });
});

describe("media paths", () => {
  it("a URL source whose error text carries an auth token does not revoke the session", async () => {
    const sendFile = TOOLS.find((t) => t.name === "telegram-send-file");
    assert.ok(sendFile);
    const telegram = { openMedia: async () => ({}), uploadStream: async () => ({}) };
    const f = await connect([sendFile], {
      telegram,
      uploads: new UploadStore(60_000),
      openUrl: async () => ({
        ok: false as const,
        reason: "bad_url" as const,
        message: "Redirect 302 pointed at an unparseable Location: https://[AUTH_KEY_UNREGISTERED",
      }),
    });
    const res = await f.client.callTool({
      name: "telegram-send-file",
      arguments: { chatId: "@me", source: { kind: "url", url: "https://example.com/a" } },
    });
    assert.match(text(res as never), /\[URL_FETCH_DENIED\]/);
    assert.deepEqual(f.revoked, [], "the healthy session is untouched");
  });

  /**
   * Owner alice: active primary account 0; a download ticket bound to secondary account 9.
   * `revoked`: the secondary's main connection fails getMe too (a real revocation); else
   * only its file connection lost the exported authorization.
   */
  function twoAccounts(opts: { revoked?: boolean; getMe?: "hangs" } = {}) {
    const revoked = opts.revoked ?? true;
    const primary = { id: "primary", openMedia: async () => ({}), uploadStream: async () => ({}) };
    const secondary = {
      id: "secondary",
      isConnected: () => true,
      getMe: async () => {
        if (opts.getMe === "hangs") return new Promise(() => {});
        if (revoked) throw rpcAuthError();
        return { id: "2" };
      },
      uploadStream: async () => {
        throw rpcAuthError();
      },
      openMedia: async () => ({
        info: { fileId: "document:1:2", size: 100 },
        readRange: async () => {
          throw rpcAuthError();
        },
        stream: async function* () {
          yield* [];
          throw rpcAuthError();
        },
      }),
    };
    const reported: Array<{ owner: string; client: unknown }> = [];
    const sessions = {
      getActiveAccountId: () => 0,
      getAccountAttachmentId: () => "attachment",
      listAccounts: () => [
        { accountId: 0, telegramUserId: "alice", addedAt: "start" },
        { accountId: 9, telegramUserId: "second", addedAt: "start" },
      ],
      ensureAccountSession: async (_owner: string, accountId: number) => (accountId === 9 ? secondary : primary),
      reportDeadSession: (owner: string, client: unknown) => reported.push({ owner, client }),
    };
    const downloads = new DownloadStore();
    const issued = downloads.issue(
      "alice",
      { chatId: "@c", messageId: 1, accountId: 9, canRead: () => true },
      { fileId: "document:1:2", size: 100, mimeType: "application/zip" },
    );
    return { primary, secondary, sessions, downloads, issued, reported };
  }

  it("an auth error on a secondary account's ticket never revokes the active primary", async () => {
    const download = TOOLS.find((t) => t.name === "telegram-download-media");
    assert.ok(download);
    const a = twoAccounts();
    const f = await connect([download], {
      telegram: a.primary,
      sessions: a.sessions as never,
      downloads: a.downloads,
      baseUrl: "https://auth-attribution-test.invalid",
    });
    const res = await f.client.callTool({
      name: "telegram-download-media",
      arguments: { chatId: "@c", messageId: 1, downloadId: a.issued.metadata.downloadId, offset: 0 },
    });
    assert.match(text(res as never), /\[ACCOUNT_UNAVAILABLE\]/);
    assert.deepEqual(f.revoked, [], "the registry did not revoke the caller's client");
    assert.deepEqual(a.reported, [{ owner: "alice", client: a.secondary }], "reported for the raising client only");
  });

  it("HTTP links attribute auth errors to the link's own account client", async () => {
    const a = twoAccounts();
    const uploads = new UploadStore(60_000);
    const app = new Hono();
    app.route("/", createTransferRoutes({ sessions: a.sessions as never, downloads: a.downloads, uploads }));
    // The file was found, so the revocation surfaces mid-stream: the body aborts.
    const res = await app.request(`/d/${a.issued.oneTimeToken}`);
    await assert.rejects(() => res.arrayBuffer(), /account this file belongs to/);
    const link = uploads.createLink("alice", { accountId: 9, canUse: () => true }, "a.bin", 3);
    assert.ok(!("error" in link));
    const put = await app.request(`/u/${link.token}`, {
      method: "PUT",
      body: "abc",
      headers: { "content-length": "3" },
    });
    assert.equal(((await put.json()) as { error: string }).error, "ACCOUNT_UNAVAILABLE");
    assert.deepEqual(
      a.reported.map((r) => r.client),
      [a.secondary, a.secondary],
    );
  });

  it("a file connection's auth error is not reported when the main connection is fine", async () => {
    const download = TOOLS.find((t) => t.name === "telegram-download-media");
    assert.ok(download);
    const a = twoAccounts({ revoked: false });
    const f = await connect([download], {
      telegram: a.primary,
      sessions: a.sessions as never,
      downloads: a.downloads,
      baseUrl: "https://auth-attribution-test.invalid",
    });
    const res = await f.client.callTool({
      name: "telegram-download-media",
      arguments: { chatId: "@c", messageId: 1, downloadId: a.issued.metadata.downloadId, offset: 0 },
    });
    assert.match(text(res as never), /\[ACCOUNT_UNAVAILABLE retryable retryAfterMs=3000\]/);
    const uploads = new UploadStore(60_000);
    const app = new Hono();
    app.route("/", createTransferRoutes({ sessions: a.sessions as never, downloads: a.downloads, uploads }));
    const stream = await app.request(
      `/d/${a.downloads.issue("alice", { chatId: "@c", messageId: 1, accountId: 9, canRead: () => true }, { fileId: "document:1:2", size: 100, mimeType: "application/zip" }).oneTimeToken}`,
    );
    await assert.rejects(() => stream.arrayBuffer(), /still signed in/);
    const link = uploads.createLink("alice", { accountId: 9, canUse: () => true }, "a.bin", 3);
    assert.ok(!("error" in link));
    const put = await app.request(`/u/${link.token}`, {
      method: "PUT",
      body: "abc",
      headers: { "content-length": "3" },
    });
    assert.equal(((await put.json()) as { error: string }).error, "ACCOUNT_UNAVAILABLE");
    assert.equal(put.headers.get("retry-after"), "3");
    assert.deepEqual(a.reported, [], "no session was reported dead");
    assert.deepEqual(f.revoked, []);
  });

  it("the call's own client is revoked only after getMe confirms it", async () => {
    const download = TOOLS.find((t) => t.name === "telegram-download-media");
    assert.ok(download);
    const { config } = await import("../config.js");
    const savedConnect = config.telegramConnectTimeoutMs;
    config.telegramConnectTimeoutMs = 30;
    try {
      for (const main of ["ok", "revoked", "hangs"] as const) {
        const mainRevoked = main === "revoked";
        const primary = {
          id: "primary",
          openMedia: async () => ({}),
          uploadStream: async () => ({}),
          getMediaInfo: async () => {
            throw rpcAuthError();
          },
          getMe: async () => {
            if (main === "hangs") return new Promise(() => {}); // a getMe that never answers
            if (mainRevoked) throw rpcAuthError();
            return { id: "1" };
          },
        };
        const a = twoAccounts();
        const f = await connect([download], {
          telegram: primary,
          sessions: a.sessions as never,
          downloads: a.downloads,
          baseUrl: "https://auth-attribution-test.invalid",
        });
        const res = await f.client.callTool({
          name: "telegram-download-media",
          arguments: { chatId: "@c", messageId: 1, file: true },
        });
        if (mainRevoked) {
          assert.deepEqual(f.revoked, [primary], "confirmed: the registry revokes the call's client");
        } else {
          assert.deepEqual(f.revoked, [], `getMe ${main}: the session stays`);
          assert.match(text(res as never), /\[ACCOUNT_UNAVAILABLE retryable retryAfterMs=3000\]/);
        }
      }
    } finally {
      config.telegramConnectTimeoutMs = savedConnect;
    }
  });

  it("a getMe that never answers does not revoke a ticket's or link's account", async () => {
    const { config } = await import("../config.js");
    const savedConnect = config.telegramConnectTimeoutMs;
    config.telegramConnectTimeoutMs = 30;
    try {
      const download = TOOLS.find((t) => t.name === "telegram-download-media");
      assert.ok(download);
      const a = twoAccounts({ getMe: "hangs" });
      const f = await connect([download], {
        telegram: a.primary,
        sessions: a.sessions as never,
        downloads: a.downloads,
        baseUrl: "https://auth-attribution-test.invalid",
      });
      const started = Date.now();
      const res = await f.client.callTool({
        name: "telegram-download-media",
        arguments: { chatId: "@c", messageId: 1, downloadId: a.issued.metadata.downloadId, offset: 0 },
      });
      assert.ok(Date.now() - started < 2000, "answered at the confirmation deadline");
      assert.match(text(res as never), /\[ACCOUNT_UNAVAILABLE retryable retryAfterMs=3000\]/);
      const uploads = new UploadStore(60_000);
      const app = new Hono();
      app.route("/", createTransferRoutes({ sessions: a.sessions as never, downloads: a.downloads, uploads }));
      const link = uploads.createLink("alice", { accountId: 9, canUse: () => true }, "a.bin", 3);
      assert.ok(!("error" in link));
      const put = await app.request(`/u/${link.token}`, {
        method: "PUT",
        body: "abc",
        headers: { "content-length": "3" },
      });
      assert.equal(((await put.json()) as { error: string }).error, "ACCOUNT_UNAVAILABLE");
      assert.deepEqual(a.reported, [], "no session was reported dead");
      assert.deepEqual(f.revoked, []);
    } finally {
      config.telegramConnectTimeoutMs = savedConnect;
    }
  });
});
