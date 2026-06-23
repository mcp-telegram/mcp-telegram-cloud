// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-download-media-thumb-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { TOOLS } = await import("../tools.js");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

/** Capture the options the handler forwards to downloadMediaAsBuffer. */
function makeDeps(result: { buffer: Buffer; mimeType: string; isThumb: boolean }) {
  const calls: Array<unknown> = [];
  const telegram = {
    downloadMediaAsBuffer: async (_chatId: string, _messageId: number, options?: { thumb?: number }) => {
      calls.push(options);
      return result;
    },
  };
  return { deps: { telegram } as never, calls };
}

const tool = TOOLS.find((t) => t.name === "telegram-download-media");

describe("telegram-download-media thumbnail default", () => {
  it("defaults to thumb:0 (cheap preview) when full is not set", async () => {
    assert.ok(tool, "telegram-download-media missing from TOOLS");
    if (!tool) return;
    const { deps, calls } = makeDeps({ buffer: JPEG, mimeType: "image/jpeg", isThumb: true });
    const res = (await tool.handler({ chatId: "@c", messageId: 1 }, deps)) as { content: unknown[] };
    assert.deepEqual(calls[0], { thumb: 0 }, "default call must request the smallest thumbnail");
    // Image + a text note steering toward full:true.
    assert.equal(res.content.length, 2);
    assert.equal((res.content[0] as { type: string }).type, "image");
    assert.match((res.content[1] as { text: string }).text, /full:true/);
  });

  it("fetches the full image (no thumb) when full:true", async () => {
    assert.ok(tool);
    if (!tool) return;
    const { deps, calls } = makeDeps({ buffer: JPEG, mimeType: "image/jpeg", isThumb: false });
    await tool.handler({ chatId: "@c", messageId: 1, full: true }, deps);
    assert.equal(calls[0], undefined, "full:true must NOT pass a thumb option (full resolution)");
  });

  it("exposes a full:boolean input describing the cost trade-off", () => {
    assert.ok(tool?.inputSchema, "download-media should expose an input schema");
    assert.ok("full" in (tool.inputSchema as Record<string, unknown>), "missing 'full' input");
  });
});
