/**
 * SSRF guard: IPv4 destinations embedded in an IPv6 literal.
 *
 * Found 2026-08-25 while triaging a `bun audit` advisory about IPv4-mapped
 * misclassification in a transitive dep. Our own guard had the same class of
 * hole, and it was reachable:
 *
 *   `new URL("https://[::ffff:10.0.1.20]/x").hostname` === "[::ffff:a00:114]"
 *
 * WHATWG URL rewrites the mapped address into HEX before any of our checks run,
 * so the old dotted-form branch (`::ffff:1.2.3.4`) never matched, the address
 * was classified public, and the fetch was allowed. 10.0.1.20 is not a
 * hypothetical: it is the swarm-internal address of our own backend, visible in
 * the deploy logs as ServiceAddr 10.0.1.20:3000.
 *
 * Three encodings reach an IPv4 host and must all be judged by IPv4 rules:
 * IPv4-mapped (::ffff:0:0/96), the deprecated IPv4-compatible (::/96), and
 * NAT64 (64:ff9b::/96).
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { isPrivateAddress } = await import("../url-fetcher.js");

/** What `new URL()` actually hands the guard for a given authority. */
const asHostname = (authority: string): string => {
  const h = new URL(`https://${authority}/x`).hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
};

describe("SSRF guard — IPv4 embedded in IPv6", () => {
  it("blocks the hex form URL normalisation actually produces", () => {
    // The regression itself: these are what the old code saw and allowed.
    assert.equal(isPrivateAddress("::ffff:7f00:1"), true, "hex-mapped loopback must be blocked");
    assert.equal(isPrivateAddress("::ffff:a00:114"), true, "hex-mapped 10.0.1.20 must be blocked");
    assert.equal(isPrivateAddress("::ffff:a9fe:a9fe"), true, "hex-mapped cloud metadata must be blocked");
  });

  it("blocks the same addresses end-to-end through URL normalisation", () => {
    for (const authority of ["[::ffff:127.0.0.1]", "[::ffff:10.0.1.20]", "[::ffff:169.254.169.254]"]) {
      const hostname = asHostname(authority);
      assert.equal(isPrivateAddress(hostname), true, `${authority} normalised to ${hostname} and slipped through`);
    }
  });

  it("blocks IPv4-compatible and NAT64 encodings of the same target", () => {
    assert.equal(isPrivateAddress("::a00:114"), true, "IPv4-compatible ::10.0.1.20");
    assert.equal(isPrivateAddress("64:ff9b::a00:114"), true, "NAT64 -> 10.0.1.20");
    assert.equal(isPrivateAddress("64:ff9b::7f00:1"), true, "NAT64 -> 127.0.0.1");
  });

  it("still blocks the dotted mapped form (no regression on the old branch)", () => {
    assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateAddress("::ffff:192.168.1.1"), true);
  });

  it("still blocks plain IPv6 ranges", () => {
    for (const a of ["::1", "::", "fe80::1", "fc00::1", "ff02::1"]) {
      assert.equal(isPrivateAddress(a), true, `${a} must stay blocked`);
    }
  });

  it("does NOT over-block public addresses", () => {
    // The danger of a broad fix: mapped/compat detection must not swallow
    // ordinary public IPv6, nor mapped forms of public IPv4.
    assert.equal(isPrivateAddress("2606:4700:4700::1111"), false, "Cloudflare DNS is public");
    assert.equal(isPrivateAddress("2001:4860:4860::8888"), false, "Google DNS is public");
    assert.equal(isPrivateAddress("::ffff:808:808"), false, "mapped 8.8.8.8 is public");
    assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false, "dotted mapped 8.8.8.8 is public");
    assert.equal(isPrivateAddress("64:ff9b::808:808"), false, "NAT64 to 8.8.8.8 is public");
  });

  it("treats malformed IPv6 as not-an-IP rather than throwing", () => {
    for (const junk of ["::ffff:zzzz:1", "1:2:3:4:5:6:7:8:9", "::1::2", "not-an-address"]) {
      assert.doesNotThrow(() => isPrivateAddress(junk), `${junk} must not throw`);
      assert.equal(isPrivateAddress(junk), false, `${junk} is not a valid IP literal`);
    }
  });
});

/**
 * Contract: fetchUrlSafely returns a deny envelope, never throws, for anything
 * the remote side controls. Found by review 2026-08-25: a server that aborts
 * the body mid-stream made `reader.read()` reject straight out of the function,
 * so a hostile (or merely flaky) upstream turned a handled upload failure into
 * an unhandled 500.
 */
describe("fetchUrlSafely — hostile upstream cannot make us throw", () => {
  const withStubbedFetch = async (body: ReadableStream<Uint8Array>) => {
    const original = globalThis.fetch;
    // Double cast: the stub only needs to be callable, but `typeof fetch` also
    // carries statics like `preconnect` that a bare arrow function lacks.
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    try {
      const { fetchUrlSafely } = await import("../url-fetcher.js");
      // 8.8.8.8 is public, so validation passes and we reach the body stream.
      return await fetchUrlSafely("https://8.8.8.8/x", { maxBytes: 1024, timeoutMs: 2000 });
    } finally {
      globalThis.fetch = original;
    }
  };

  it("returns a deny envelope when the body stream errors mid-transfer", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("stream boom"));
      },
    });

    const result = await withStubbedFetch(body);
    assert.equal(result.ok, false, "an aborted upstream body must not resolve as success");
    if (!result.ok) {
      assert.equal(result.reason, "fetch_failed");
      assert.match(result.message, /aborted the response body/);
    }
  });
});
