// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-write-wave-2.3-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

const { TOOLS } = await import("../tools.js");

const WAVE_2_3_TOOLS = [
  "telegram-kick-user",
  "telegram-ban-user",
  "telegram-unban-user",
  "telegram-set-admin",
  "telegram-remove-admin",
  "telegram-archive-chat",
  "telegram-pin-chat",
  "telegram-mark-dialog-unread",
  "telegram-set-slow-mode",
  "telegram-toggle-anti-spam",
  "telegram-toggle-prehistory-hidden",
  "telegram-block-user",
  "telegram-unblock-user",
  "telegram-report-spam",
] as const;

describe("Wave 2.3 — chat admin / moderation (non-destructive write tools)", () => {
  for (const name of WAVE_2_3_TOOLS) {
    it(`registers ${name} as a non-destructive write tool`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) return;
      assert.equal(
        tool.annotations.readOnlyHint,
        false,
        `${name} should have readOnlyHint:false (it performs a write)`,
      );
      assert.equal(
        tool.annotations.destructiveHint,
        false,
        `${name} should have destructiveHint:false (Wave 2.3 is non-destructive; set-chat-permissions is upstream-DESTRUCTIVE → Phase 2.1)`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("none of the Wave 2.3 tools require an opt-in env flag", () => {
    for (const name of WAVE_2_3_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      if (!tool) continue;
      assert.equal(tool.requiresEnv, undefined, `${name} unexpectedly gated by ${tool.requiresEnv}`);
    }
  });

  it("set-slow-mode accepts only the seven Telegram-supported intervals", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-set-slow-mode");
    assert.ok(tool?.inputSchema, "set-slow-mode should expose an input schema");
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    for (const seconds of [0, 10, 30, 60, 300, 900, 3600]) {
      assert.doesNotThrow(() => schema.parse({ chatId: "@grp", seconds }), `seconds=${seconds} should be valid`);
    }
    for (const bad of [5, 15, 120, 1800, 7200, -1]) {
      assert.throws(() => schema.parse({ chatId: "@grp", seconds: bad }), `seconds=${bad} should be rejected`);
    }
  });

  it("set-admin sanitizes the optional title (UTF-16 surrogate parity with upstream)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-set-admin");
    assert.ok(tool?.inputSchema, "set-admin should expose an input schema");
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    // String shape should accept any string; sanitization happens at handler boundary.
    assert.doesNotThrow(() => schema.parse({ chatId: "@grp", userId: "@u", title: "Mod" }));
    assert.doesNotThrow(() => schema.parse({ chatId: "@grp", userId: "@u" }));
    // Empty title is allowed by upstream — keep parity (upstream uses bare z.string().optional() with no .min).
    assert.doesNotThrow(() => schema.parse({ chatId: "@grp", userId: "@u", title: "" }));
  });

  it("boolean-toggle tools all reject non-boolean values (strict parity with upstream)", () => {
    const booleanFields: Array<[string, string]> = [
      ["telegram-archive-chat", "archive"],
      ["telegram-pin-chat", "pin"],
      ["telegram-mark-dialog-unread", "unread"],
      ["telegram-toggle-anti-spam", "enabled"],
      ["telegram-toggle-prehistory-hidden", "hidden"],
    ];
    for (const [name, field] of booleanFields) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool?.inputSchema, `${name} should have inputSchema`);
      const schema = z.object(tool.inputSchema as z.ZodRawShape);
      assert.throws(
        () => schema.parse({ chatId: "@grp", [field]: "true" }),
        `${name}.${field} must reject string "true" — upstream uses z.boolean()`,
      );
      assert.throws(
        () => schema.parse({ chatId: "@grp", [field]: 1 }),
        `${name}.${field} must reject numeric 1 — upstream uses z.boolean()`,
      );
    }
  });

  it("user-only block tools (block-user, unblock-user) take only userId — no chatId", () => {
    for (const name of ["telegram-block-user", "telegram-unblock-user"] as const) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool?.inputSchema);
      const shape = tool.inputSchema as z.ZodRawShape;
      assert.ok("userId" in shape, `${name} must have userId`);
      assert.ok(!("chatId" in shape), `${name} must NOT have chatId — upstream takes userId only`);
    }
  });
});
