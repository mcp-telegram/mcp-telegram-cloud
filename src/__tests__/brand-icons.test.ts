/**
 * The hosted server's icons are the Chatroost mark, not Telegram's paper plane.
 *
 * `serverInfo.icons`, the QR sign-in page and directory listings all load these URLs. The plane
 * reads as Telegram's logo, which Telegram's API ToS (2.4) forbids and which got the ChatGPT
 * listing rejected; it survived on this host for weeks after the website had been rebranded.
 */
process.env.ISSUER ??= "https://brand-icons-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { createStaticRoutes } = await import("../routes/static.js");

const app = createStaticRoutes({ sessions: {} as never });

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Uint8Array): { w: number; h: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.deepEqual([...buf.slice(1, 4)], [0x50, 0x4e, 0x47], "not a PNG");
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

describe("brand icons", () => {
  for (const [path, size] of [
    ["/icon.png", 128],
    ["/icon-256.png", 256],
    ["/icon-512.png", 512],
    ["/favicon.ico", 32],
  ] as const) {
    it(`${path} is a ${size}×${size} PNG`, async () => {
      const res = await app.request(path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.deepEqual(pngSize(new Uint8Array(await res.arrayBuffer())), { w: size, h: size });
    });
  }

  it("/icon.svg is the Chatroost mark, not the paper plane", async () => {
    const res = await app.request("/icon.svg");
    assert.equal(res.status, 200);
    const svg = await res.text();
    assert.match(svg, /^<svg /);
    assert.ok(!svg.includes("M228.88,26.19"), "the Telegram-like paper plane is back");
  });
});
