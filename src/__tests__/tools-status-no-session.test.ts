/**
 * telegram-status with no Telegram session in the pool.
 *
 * Tools flagged `skipRequireConnection: true` receive the `undefined`
 * placeholder from tool-registry.ts when `getTelegram()` throws. Reporting
 * that state is precisely what telegram-status is for, so it must answer
 * "not connected" rather than dereference the placeholder and blow up with
 * `undefined is not an object (evaluating 'telegram.ensureConnected')`
 * — observed once in prod on 2026-08-05.
 */
process.env.ISSUER ??= "https://tools-status-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { TOOLS } = await import("../tools.js");

function getTool(name: string) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Test setup: ${name} not registered`);
  return tool;
}

/** Mirrors what the registry hands a skipRequireConnection tool when no session exists. */
const NO_SESSION_DEPS = {
  telegram: undefined as unknown as TelegramService,
  userId: "u:test",
};

describe("telegram-status — no session in pool", () => {
  it("answers instead of throwing when telegram is the undefined placeholder", async () => {
    const tool = getTool("telegram-status");
    assert.equal(tool.skipRequireConnection, true, "status must skip requireConnection");

    const result = await tool.handler({}, NO_SESSION_DEPS);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");

    assert.match(text, /not connected/i, `expected a not-connected answer, got: ${text}`);
    assert.doesNotMatch(text, /undefined is not an object/i);
    assert.notEqual(result.isError, true, "a missing session is a reportable state, not a tool error");
  });

  it("every skipRequireConnection tool tolerates the undefined telegram placeholder", async () => {
    // The placeholder contract (tool-registry.ts) is only safe while no opted-out
    // handler dereferences `telegram`. telegram-status broke it once; catch the next one.
    const optedOut = TOOLS.filter((t) => t.skipRequireConnection);
    assert.ok(optedOut.length > 0, "expected at least one skipRequireConnection tool");

    for (const tool of optedOut) {
      const src = tool.handler.toString();
      const derefsTelegram = /\btelegram\s*\./.test(src);
      const guardsTelegram = /!\s*telegram\b|telegram\s*\?\./.test(src);
      assert.ok(
        !derefsTelegram || guardsTelegram,
        `${tool.name} dereferences \`telegram\` without a guard, but opts out of requireConnection`,
      );
    }
  });
});
