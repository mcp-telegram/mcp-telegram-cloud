/**
 * Body deadline (security audit 2026-11-02).
 *
 * The timeout used to cover only the time to response headers: the timer was cleared
 * as soon as `fetch()` resolved, and the body was then read with no limit. A server that
 * answered at once and dripped the body held the connection and up to `maxBytes` of
 * memory forever, so a user could pin the shared backend with a handful of calls.
 *
 * The network is replaced by a `fetch` double that behaves like Bun's: aborting the
 * request signal errors the body stream. A public IP literal skips DNS.
 */
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const { fetchUrlSafely } = await import("../url-fetcher.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Headers at once, then one byte and silence until the request is aborted. */
function drippingFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }) as typeof fetch;
}

describe("fetchUrlSafely bounds the whole download, body included", () => {
  it("a body that never finishes ends as a timeout", async () => {
    globalThis.fetch = drippingFetch();
    const started = Date.now();

    const result = await Promise.race([
      fetchUrlSafely("https://1.1.1.1/file.bin", { maxBytes: 1024, timeoutMs: 200 }),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000)),
    ]);

    if (result === "hung") assert.fail("the body read must not outlive the timeout");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "timeout");
    assert.ok(Date.now() - started < 1500);
  });

  it("a fast download is unaffected", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchUrlSafely("https://1.1.1.1/file.bin", { maxBytes: 1024, timeoutMs: 200 });
    assert.ok(result.ok);
    assert.equal(result.ok && result.bytes.length, 3);
  });
});
