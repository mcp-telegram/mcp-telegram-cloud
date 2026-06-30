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

  // Token-optimization Tier 1: get-stars-status / get-stars-transactions now
  // return curated text, NOT a raw JSON.stringify dump. Lock the format so a
  // future change can't silently regress back to a verbose JSON blob.
  it("get-stars-status renders curated text (not raw JSON)", async () => {
    const tool = TOOLS.find((t) => t.name === "telegram-get-stars-status");
    assert.ok(tool?.handler);
    if (!tool?.handler) return;
    const stub = {
      getStarsStatus: async () => ({
        balance: { amount: "1500", nanos: 0 },
        history: [
          {
            id: "txn_a",
            stars: { amount: "100", nanos: 0 },
            date: 1782700000,
            peer: { kind: "premiumBot" },
            title: "Sub",
          },
          {
            id: "txn_b",
            stars: { amount: "25", nanos: 500000000 },
            date: 1782600000,
            peer: { kind: "peer", peer: { kind: "user", id: "117799143" } },
            gift: true,
            pending: false,
          },
        ],
        nextOffset: "cur1",
      }),
    } as unknown as TelegramService;
    const res = await tool.handler({ peer: "me" } as never, { telegram: stub } as never);
    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    // Not JSON
    assert.throws(() => JSON.parse(text), "curated output must not be valid JSON");
    // Curated essentials present
    assert.match(text, /balance=1500⭐/);
    assert.match(text, /transactions \(2\):/);
    assert.match(text, /\[txn_a\] 100⭐ premiumBot date=2026-/); // ISO date, not unix
    assert.match(text, /25\.5⭐ user:117799143/); // nanos fraction + peer
    assert.match(text, /\[gift\]/);
    assert.doesNotMatch(text, /pending/, "falsy flags must be dropped");
    assert.match(text, /nextOffset=cur1/);
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
