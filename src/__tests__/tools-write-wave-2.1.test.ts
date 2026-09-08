// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-write-wave-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

const { TOOLS } = await import("../tools.js");

const WAVE_2_1_TOOLS = [
  "telegram-send-reaction",
  "telegram-set-default-reaction",
  "telegram-send-paid-reaction",
  "telegram-toggle-paid-reaction-privacy",
  "telegram-react-to-story",
  "telegram-save-draft",
  "telegram-vote-poll",
  "telegram-rate-transcription",
] as const;

describe("Wave 2.1 — write tools (reactions / drafts / votes)", () => {
  for (const name of WAVE_2_1_TOOLS) {
    it(`registers ${name} as a write tool`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) return; // type narrowing
      assert.equal(
        tool.annotations.readOnlyHint,
        false,
        `${name} should have readOnlyHint:false (it performs a write)`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("only the Stars-spending tool is behind an opt-in env flag", () => {
    for (const name of WAVE_2_1_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) continue;
      // send-paid-reaction moves real money (Stars) irreversibly, so the hosted
      // deployment keeps it off by default alongside the rest of the Stars
      // surface. Everything else in this wave is free and reversible.
      const expected = name === "telegram-send-paid-reaction" ? "MCP_TELEGRAM_ENABLE_STARS" : undefined;
      assert.equal(tool.requiresEnv, expected, `${name} gating changed unexpectedly`);
    }
  });

  it("Wave 2.1 send-reaction default for addToExisting is false (parity with upstream)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-reaction");
    assert.ok(tool?.inputSchema, "send-reaction should expose an input schema");
    // Parse a payload that omits addToExisting and confirm Zod fills in the upstream default (false).
    // Using a Zod object so we can `.parse()` the raw shape.
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    const parsed = schema.parse({ chatId: "@me", messageId: 1, emoji: "👍" });
    assert.equal(
      (parsed as { addToExisting: boolean }).addToExisting,
      false,
      "addToExisting should default to false (replace, not append)",
    );
  });
});
