import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchUrlSafely, isPrivateAddress } from "../url-fetcher.js";

describe("isPrivateAddress — IPv4 ranges", () => {
  // Each `ok` IP must be classified as PRIVATE (not safe to fetch).
  const PRIVATE_IPV4 = [
    "0.0.0.0",
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.169.254", // AWS/GCP/Azure metadata
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
    "192.0.2.42", // TEST-NET-1
    "198.51.100.42", // TEST-NET-2
    "203.0.113.42", // TEST-NET-3
    "198.18.0.1", // benchmarking
  ];

  for (const ip of PRIVATE_IPV4) {
    it(`rejects ${ip} as private`, () => {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be classified as private`);
    });
  }

  const PUBLIC_IPV4 = ["8.8.8.8", "1.1.1.1", "151.101.0.1", "172.32.0.1", "169.255.0.1"];
  for (const ip of PUBLIC_IPV4) {
    it(`allows ${ip} as public`, () => {
      assert.equal(isPrivateAddress(ip), false, `${ip} must be classified as public`);
    });
  }
});

describe("isPrivateAddress — IPv6 ranges", () => {
  const PRIVATE_IPV6 = [
    "::1", // loopback
    "::", // unspecified
    "fc00::1", // ULA
    "fd00::1", // ULA
    "fe80::1", // link-local
    "fec0::1", // deprecated site-local
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:169.254.169.254", // IPv4-mapped metadata
  ];
  for (const ip of PRIVATE_IPV6) {
    it(`rejects ${ip} as private`, () => {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be private`);
    });
  }

  const PUBLIC_IPV6 = ["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of PUBLIC_IPV6) {
    it(`allows ${ip} as public`, () => {
      assert.equal(isPrivateAddress(ip), false, `${ip} must be public`);
    });
  }
});

describe("isPrivateAddress — non-IP input", () => {
  it("returns false for a hostname (caller is expected to resolve first)", () => {
    assert.equal(isPrivateAddress("example.com"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isPrivateAddress(""), false);
  });
});

describe("fetchUrlSafely — scheme + URL validation", () => {
  it("rejects non-https scheme", async () => {
    const res = await fetchUrlSafely("http://example.com/", { maxBytes: 1024 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "bad_scheme");
  });

  it("rejects file://", async () => {
    const res = await fetchUrlSafely("file:///etc/passwd", { maxBytes: 1024 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "bad_scheme");
  });

  it("rejects invalid URL string", async () => {
    const res = await fetchUrlSafely("not a url at all", { maxBytes: 1024 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "bad_url");
  });

  it("rejects an https URL whose hostname is a literal private IP", async () => {
    const res = await fetchUrlSafely("https://127.0.0.1/", { maxBytes: 1024 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "private_address");
  });

  it("rejects an https URL whose hostname is the AWS metadata IP literal", async () => {
    const res = await fetchUrlSafely("https://169.254.169.254/latest/meta-data/", { maxBytes: 1024 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "private_address");
  });

  it("rejects ::1 (IPv6 loopback) literal", async () => {
    const res = await fetchUrlSafely("https://[::1]/", { maxBytes: 1024 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "private_address");
  });

  it("throws on non-positive maxBytes (programmer error)", async () => {
    await assert.rejects(() => fetchUrlSafely("https://example.com/", { maxBytes: 0 }), /maxBytes must be positive/);
  });
});

describe("fetchUrlSafely — DNS-failure path", () => {
  it("returns dns_failure for a hostname that does not resolve", async () => {
    const res = await fetchUrlSafely("https://this-domain-must-not-exist.invalid/", { maxBytes: 1024 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "dns_failure");
  });
});
