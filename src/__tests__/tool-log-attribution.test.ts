/**
 * `tool.duration` / `tool.error` must say WHO made the call (hashed user + MCP client),
 * the same way `tool.call` does.
 *
 * Without it a slow-tool alert cannot tell "one heavy user queueing behind their own
 * per-user lock" (routinely 20-35% of all calls >5s) from "everyone is slow", and error
 * spikes cannot be attributed to a client. The user id must stay hashed via logUser —
 * a raw Telegram id in logs is a privacy regression.
 */
process.env.ISSUER ??= "https://tool-log-attribution-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { registerAllTools } = await import("../tool-registry.js");
const { READ_ONLY } = await import("../tools/helpers.js");
const { logger, logUser } = await import("../logger.js");

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Callback = (args: unknown) => Promise<Result>;
type Captured = { level: string; msg: string; attrs: Record<string, unknown> };

const RAW_USER_ID = "265716044";
let captured: Captured[] = [];
const original = { info: logger.info, warn: logger.warn, error: logger.error };

beforeEach(() => {
  captured = [];
  for (const level of ["info", "warn", "error"] as const) {
    (logger as Record<string, unknown>)[level] = (msg: string, attrs?: Record<string, unknown>) => {
      captured.push({ level, msg, attrs: attrs ?? {} });
    };
  }
});

afterEach(() => {
  Object.assign(logger, original);
});

function register(handler: () => Promise<Result>, opts: { userId?: string; clientName?: string }): Callback {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let cb: Callback | undefined;
  const orig = server.registerTool.bind(server);
  // biome-ignore lint/suspicious/noExplicitAny: SDK signature is overloaded; capture+relay only.
  (server as any).registerTool = (name: string, config: unknown, callback: Callback) => {
    cb = callback;
    return orig(name, config as never, callback as never);
  };
  registerAllTools(server, [{ name: "attr-tool", description: "t", annotations: READ_ONLY, handler }], {
    getTelegram: () => ({}) as TelegramService,
    requireConnection: async () => null,
    ...opts,
  });
  assert.ok(cb, "tool was not registered");
  return cb;
}

const byEvent = (event: string) => captured.filter((c) => c.attrs.event === event);

describe("tool log attribution", () => {
  it("tool.duration on success carries the hashed userId and client", async () => {
    const call = register(async () => ({ content: [{ type: "text", text: "ok" }] }), {
      userId: RAW_USER_ID,
      clientName: "Claude",
    });
    await call({});
    const [rec] = byEvent("tool.duration");
    assert.ok(rec, "no tool.duration logged");
    assert.equal(rec.attrs.userId, logUser(RAW_USER_ID));
    assert.equal(rec.attrs.client, "Claude");
  });

  it("tool.duration and tool.error on a thrown error carry the hashed userId and client", async () => {
    const call = register(
      async () => {
        throw new Error("A wait of 5 seconds is required");
      },
      { userId: RAW_USER_ID, clientName: "ChatGPT" },
    );
    const res = await call({});
    assert.equal(res.isError, true);
    for (const event of ["tool.duration", "tool.error"]) {
      const [rec] = byEvent(event);
      assert.ok(rec, `no ${event} logged`);
      assert.equal(rec.attrs.userId, logUser(RAW_USER_ID), `${event} userId`);
      assert.equal(rec.attrs.client, "ChatGPT", `${event} client`);
    }
  });

  it("never logs the raw Telegram user id when hashing is on", async () => {
    const { config } = await import("../config.js");
    const prev = config.logUserIds;
    (config as { logUserIds: boolean }).logUserIds = false;
    try {
      const call = register(
        async () => {
          throw new Error("boom");
        },
        { userId: RAW_USER_ID, clientName: "Cursor" },
      );
      await call({});
      const leaked = captured.filter((c) => JSON.stringify(c.attrs).includes(RAW_USER_ID));
      assert.deepEqual(leaked, [], "raw user id leaked into log attributes");
      assert.match(String(byEvent("tool.error")[0]?.attrs.userId), /^u:[0-9a-f]{10}$/);
    } finally {
      (config as { logUserIds: boolean }).logUserIds = prev;
    }
  });

  it("omits the fields entirely when the caller is unknown (no empty strings)", async () => {
    const call = register(async () => ({ content: [{ type: "text", text: "ok" }] }), {});
    await call({});
    const [rec] = byEvent("tool.duration");
    assert.ok(rec);
    assert.equal("userId" in rec.attrs, false);
    assert.equal("client" in rec.attrs, false);
  });
});
