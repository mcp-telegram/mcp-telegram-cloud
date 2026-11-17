/**
 * openUrlStream: the URL source for send tools streams into Telegram, so the fetcher
 * hands the body over as it arrives. Same SSRF policy as fetchUrlSafely; these tests
 * pin what the streaming variant adds: trustworthy size, mid-stream cap, idle timeout.
 * The network is a `fetch` double; a public IP literal skips DNS.
 */
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const { openUrlStream, UrlFetchError } = await import("../url-fetcher.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(body: ReadableStream<Uint8Array> | Uint8Array, headers: Record<string, string> = {}): void {
  globalThis.fetch = (async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch;
}

async function drain(it: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of it) n += c.byteLength;
  return n;
}

describe("openUrlStream", () => {
  it("reports the declared size for an unencoded body and streams it", async () => {
    serve(new Uint8Array(1000), { "content-length": "1000", "content-type": "application/pdf" });
    const r = await openUrlStream("https://1.1.1.1/a.pdf", { maxBytes: 5000 });
    assert.ok(r.ok);
    assert.equal(r.ok && r.size, 1000);
    assert.equal(r.ok && r.mime, "application/pdf");
    assert.equal(r.ok && (await drain(r.body)), 1000);
  });

  it("treats a compressed body's length as unknown", async () => {
    serve(new Uint8Array(10), { "content-length": "10", "content-encoding": "gzip" });
    const r = await openUrlStream("https://1.1.1.1/a", { maxBytes: 5000 });
    assert.ok(r.ok);
    assert.equal(r.ok && r.size, undefined);
    if (r.ok) r.cancel();
  });

  it("refuses a declared length above the cap before reading", async () => {
    serve(new Uint8Array(10), { "content-length": "10" });
    const r = await openUrlStream("https://1.1.1.1/a", { maxBytes: 5 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "too_large");
  });

  it("stops a body that grows past the cap mid-stream", async () => {
    serve(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(4));
          c.enqueue(new Uint8Array(4));
          c.close();
        },
      }),
    );
    const r = await openUrlStream("https://1.1.1.1/a", { maxBytes: 6 });
    assert.ok(r.ok);
    await assert.rejects(
      () => drain((r as { body: AsyncIterable<Uint8Array> }).body),
      (e: unknown) => e instanceof UrlFetchError && e.reason === "too_large",
    );
  });

  it("ends a stalled body as a timeout instead of hanging", async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const r = await openUrlStream("https://1.1.1.1/a", { maxBytes: 100, idleTimeoutMs: 100 });
    assert.ok(r.ok);
    const started = Date.now();
    await assert.rejects(
      () => drain((r as { body: AsyncIterable<Uint8Array> }).body),
      (e: unknown) => e instanceof UrlFetchError && e.reason === "timeout",
    );
    assert.ok(Date.now() - started < 1500);
  });

  it("keeps the SSRF policy", async () => {
    const r = await openUrlStream("https://127.0.0.1/a", { maxBytes: 10 });
    assert.equal(!r.ok && r.reason, "private_address");
    const http = await openUrlStream("http://example.com/a", { maxBytes: 10 });
    assert.equal(!http.ok && http.reason, "bad_scheme");
  });
});
