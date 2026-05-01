// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-stars-wave-3-ro-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { TOOLS, registerAllAllowedTools } = await import("../tools.js");
const { EXPLICIT_EXCLUDED } = await import("../parity-config.js");

const STARS_RO_TOOLS = [
  "telegram-get-stars-status",
  "telegram-get-stars-transactions",
  "telegram-get-stars-subscriptions",
  "telegram-get-stars-topup-options",
  "telegram-get-available-star-gifts",
  "telegram-get-saved-star-gifts",
] as const;

const STARS_WRITE_PENDING = [
  "telegram-save-star-gift",
  "telegram-convert-star-gift",
  "telegram-change-stars-subscription",
] as const;

describe("Wave 3 RO Stars — read-only Stars wallet/gifts/subscriptions (opt-in)", () => {
  for (const name of STARS_RO_TOOLS) {
    it(`registers ${name} as READ_ONLY + gated by MCP_TELEGRAM_ENABLE_STARS`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) return;
      assert.equal(tool.annotations.readOnlyHint, true, `${name} must be READ_ONLY`);
      assert.equal(tool.annotations.destructiveHint, false, `${name} must be non-destructive`);
      assert.equal(
        tool.requiresEnv,
        "MCP_TELEGRAM_ENABLE_STARS",
        `${name} must be gated by MCP_TELEGRAM_ENABLE_STARS (server-default OFF)`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("none of the Stars RO tools are still in EXPLICIT_EXCLUDED", () => {
    for (const name of STARS_RO_TOOLS) {
      const excluded = EXPLICIT_EXCLUDED.find((e) => e.name === name);
      assert.equal(excluded, undefined, `${name} was unlocked in Wave 3 RO and must NOT remain in EXPLICIT_EXCLUDED`);
    }
  });

  it("Stars-write tools remain pending (deferred to Phase 2.1)", () => {
    // Sanity: the destructive infra (Phase 2.1) gate hasn't shipped, so save/convert/change are
    // intentionally NOT in the whitelist. They live in scripts/parity-baseline.json `pending`.
    for (const name of STARS_WRITE_PENDING) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.equal(tool, undefined, `${name} must NOT be whitelisted yet — Phase 2.1 gates Stars writes`);
      const excluded = EXPLICIT_EXCLUDED.find((e) => e.name === name);
      assert.equal(excluded, undefined, `${name} is pending, not permanently excluded`);
    }
  });

  it("get-stars-transactions rejects inbound + outbound combo via preValidate", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-get-stars-transactions");
    assert.ok(tool?.preValidate, "telegram-get-stars-transactions must have a preValidate");
    if (!tool?.preValidate) return;
    const result = tool.preValidate({ peer: "me", inbound: true, outbound: true } as never);
    assert.ok(result, "preValidate must reject inbound+outbound combo");
    assert.equal(result.isError, true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /mutually exclusive/i);
  });

  it("get-stars-transactions allows inbound XOR outbound, or neither", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-get-stars-transactions");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;
    assert.equal(tool.preValidate({ peer: "me" } as never), null, "no filter should pass");
    assert.equal(tool.preValidate({ peer: "me", inbound: true } as never), null, "inbound alone should pass");
    assert.equal(tool.preValidate({ peer: "me", outbound: true } as never), null, "outbound alone should pass");
  });

  // Integration: prove the env-gate actually works at registration time, not just on the static array.
  // Catches regressions where someone removes `requiresEnv: STARS_ENV` from a Stars tool definition.
  it("Stars RO tools are skipped at registration when MCP_TELEGRAM_ENABLE_STARS is unset", () => {
    const prev = process.env.MCP_TELEGRAM_ENABLE_STARS;
    delete process.env.MCP_TELEGRAM_ENABLE_STARS;
    try {
      const server = new McpServer({ name: "stars-gate-off", version: "0.0.0" });
      registerAllAllowedTools(
        server,
        () => ({}) as TelegramService,
        async () => null,
      );
      const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
      for (const name of STARS_RO_TOOLS) {
        assert.ok(!(name in registered), `${name} must NOT be registered when MCP_TELEGRAM_ENABLE_STARS is unset`);
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_TELEGRAM_ENABLE_STARS;
      else process.env.MCP_TELEGRAM_ENABLE_STARS = prev;
    }
  });

  it("Stars RO tools are registered when MCP_TELEGRAM_ENABLE_STARS=1", () => {
    const prev = process.env.MCP_TELEGRAM_ENABLE_STARS;
    process.env.MCP_TELEGRAM_ENABLE_STARS = "1";
    try {
      const server = new McpServer({ name: "stars-gate-on", version: "0.0.0" });
      registerAllAllowedTools(
        server,
        () => ({}) as TelegramService,
        async () => null,
      );
      const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
      for (const name of STARS_RO_TOOLS) {
        assert.ok(name in registered, `${name} must be registered when MCP_TELEGRAM_ENABLE_STARS=1`);
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_TELEGRAM_ENABLE_STARS;
      else process.env.MCP_TELEGRAM_ENABLE_STARS = prev;
    }
  });
});
