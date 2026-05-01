// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-stars-wave-2-7-write-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { TOOLS, registerAllAllowedTools } = await import("../tools.js");
const { EXPLICIT_EXCLUDED } = await import("../parity-config.js");

const STARS_WRITE_TOOLS = [
  "telegram-save-star-gift",
  "telegram-convert-star-gift",
  "telegram-change-stars-subscription",
] as const;

describe("Wave 2.7 Stars-write — 3 write tools (opt-in via MCP_TELEGRAM_ENABLE_STARS)", () => {
  for (const name of STARS_WRITE_TOOLS) {
    it(`registers ${name} as WRITE (non-destructive) + gated by MCP_TELEGRAM_ENABLE_STARS`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) return;
      assert.equal(tool.annotations.readOnlyHint, false, `${name} must NOT be READ_ONLY (it writes state)`);
      assert.equal(
        tool.annotations.destructiveHint,
        false,
        `${name} must be non-destructive (Telegram tier=write, reversible while in window)`,
      );
      assert.equal(
        tool.requiresEnv,
        "MCP_TELEGRAM_ENABLE_STARS",
        `${name} must be gated by MCP_TELEGRAM_ENABLE_STARS (server-default OFF)`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("none of the Stars-write tools are in EXPLICIT_EXCLUDED", () => {
    for (const name of STARS_WRITE_TOOLS) {
      const excluded = EXPLICIT_EXCLUDED.find((e) => e.name === name);
      assert.equal(excluded, undefined, `${name} was unlocked in Wave 2.7 and must NOT be in EXPLICIT_EXCLUDED`);
    }
  });

  it("save-star-gift preValidate enforces msgId XOR (chatId+savedId)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-save-star-gift");
    assert.ok(tool?.preValidate, "telegram-save-star-gift must have a preValidate");
    if (!tool?.preValidate) return;

    // Empty: must reject
    const empty = tool.preValidate({} as never);
    assert.ok(empty?.isError, "empty input must be rejected");
    assert.match(empty.content[0]?.type === "text" ? empty.content[0].text : "", /Provide msgId.*chatId.*savedId/i);

    // msgId alone: ok
    assert.equal(tool.preValidate({ msgId: 42 } as never), null, "msgId alone should pass");

    // chatId+savedId: ok
    assert.equal(tool.preValidate({ chatId: "123", savedId: "999" } as never), null, "chatId+savedId should pass");

    // chatId without savedId: must reject
    const partial = tool.preValidate({ chatId: "123" } as never);
    assert.ok(partial?.isError, "chatId without savedId must be rejected");

    // Both modes simultaneously: must reject
    const both = tool.preValidate({ msgId: 42, chatId: "123", savedId: "999" } as never);
    assert.ok(both?.isError, "msgId+chatId+savedId together must be rejected");
    assert.match(both.content[0]?.type === "text" ? both.content[0].text : "", /not both/i);
  });

  it("convert-star-gift preValidate mirrors save-star-gift XOR rules", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-convert-star-gift");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;

    assert.ok(tool.preValidate({} as never)?.isError, "empty input must be rejected");
    assert.equal(tool.preValidate({ msgId: 1 } as never), null);
    assert.equal(tool.preValidate({ chatId: "c", savedId: "s" } as never), null);
    assert.ok(
      tool.preValidate({ msgId: 1, chatId: "c", savedId: "s" } as never)?.isError,
      "both modes simultaneously must be rejected",
    );
  });

  it("change-stars-subscription has no preValidate (all fields required by zod)", () => {
    // Sanity: chatId + subscriptionId + canceled are all required at the schema level,
    // so no cross-field XOR check is needed.
    const tool = TOOLS.find((t) => t.name === "telegram-change-stars-subscription");
    assert.ok(tool, "tool missing");
    assert.equal(tool?.preValidate, undefined, "no cross-field check required");
  });

  it("Stars-write tools are skipped at registration when MCP_TELEGRAM_ENABLE_STARS is unset", () => {
    const prev = process.env.MCP_TELEGRAM_ENABLE_STARS;
    delete process.env.MCP_TELEGRAM_ENABLE_STARS;
    try {
      const server = new McpServer({ name: "stars-write-gate-off", version: "0.0.0" });
      registerAllAllowedTools(
        server,
        () => ({}) as TelegramService,
        async () => null,
      );
      const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
      for (const name of STARS_WRITE_TOOLS) {
        assert.ok(!(name in registered), `${name} must NOT be registered when MCP_TELEGRAM_ENABLE_STARS is unset`);
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_TELEGRAM_ENABLE_STARS;
      else process.env.MCP_TELEGRAM_ENABLE_STARS = prev;
    }
  });

  it("Stars-write tools are registered when MCP_TELEGRAM_ENABLE_STARS=1", () => {
    const prev = process.env.MCP_TELEGRAM_ENABLE_STARS;
    process.env.MCP_TELEGRAM_ENABLE_STARS = "1";
    try {
      const server = new McpServer({ name: "stars-write-gate-on", version: "0.0.0" });
      registerAllAllowedTools(
        server,
        () => ({}) as TelegramService,
        async () => null,
      );
      const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
      for (const name of STARS_WRITE_TOOLS) {
        assert.ok(name in registered, `${name} must be registered when MCP_TELEGRAM_ENABLE_STARS=1`);
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_TELEGRAM_ENABLE_STARS;
      else process.env.MCP_TELEGRAM_ENABLE_STARS = prev;
    }
  });
});
