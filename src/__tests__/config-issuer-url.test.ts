/**
 * ISSUER validation at boot.
 *
 * ISSUER was the only url-shaped env var that skipped `httpUrl`, so the server
 * happily started with a value that could never produce working OAuth discovery
 * metadata — the failure surfaced later as 401s advertising a URL nobody serves.
 * These tests pin the boot-time contract: reject at startup, not at request time.
 *
 * The userinfo and header-safety rules exist because this value is published:
 * it is echoed in the `resource`/`authorization_servers` metadata documents and
 * embedded in the quoted `resource_metadata="..."` parameter of WWW-Authenticate.
 */
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { issuerUrl } = await import("../config.js");

describe("issuerUrl", () => {
  it("accepts an ordinary https origin", () => {
    assert.equal(issuerUrl("ISSUER", "https://mcp.example.com"), "https://mcp.example.com");
  });

  it("accepts http for local development", () => {
    assert.equal(issuerUrl("ISSUER", "http://localhost:3000"), "http://localhost:3000");
  });

  it("strips trailing slashes so callers can concatenate safely", () => {
    assert.equal(issuerUrl("ISSUER", "https://mcp.example.com///"), "https://mcp.example.com");
  });

  it("rejects a value that is not a URL at all (the original gap)", () => {
    assert.throws(() => issuerUrl("ISSUER", "not-a-url"), /is not a valid URL/);
  });

  it("rejects a non-http scheme", () => {
    assert.throws(() => issuerUrl("ISSUER", "javascript:alert(1)"), /must be an http\(s\) URL/);
  });

  it("rejects userinfo — it would be published in OAuth metadata", () => {
    // trufflehog:ignore — fake userinfo asserted to be REJECTED, not a credential
    assert.throws(() => issuerUrl("ISSUER", "https://user:pass@mcp.example.com"), /must not contain userinfo/); // trufflehog:ignore
    assert.throws(() => issuerUrl("ISSUER", "https://user@mcp.example.com"), /must not contain userinfo/);
  });

  it('rejects a quote — it would break out of resource_metadata="..."', () => {
    assert.throws(() => issuerUrl("ISSUER", 'https://ho"st.example.com'), /must not contain quotes/);
  });

  it("rejects a backslash, which URL parsing would silently rewrite into the path", () => {
    // `https://ho\st.example.com` parses to host "ho" + path "/st.example.com",
    // so a check against the PARSED host would never see the backslash and the
    // effective issuer would differ from the configured one without a word.
    assert.throws(() => issuerUrl("ISSUER", "https://ho\\st.example.com"), /must not contain quotes/);
  });

  it("rejects whitespace and control characters", () => {
    assert.throws(() => issuerUrl("ISSUER", "https://host.example.com /x"), /must not contain quotes/);
    assert.throws(() => issuerUrl("ISSUER", "https://host.example.com\u0007"), /must not contain quotes/);
  });

  it("rejects a path component — every route here is mounted at the origin root", () => {
    // Not cosmetic: routes/my.tsx compares `new URL(x).origin === config.issuer`,
    // which can never match an issuer carrying a path, and the RFC 8414 metadata
    // is served from the root well-known path regardless of this value.
    assert.throws(() => issuerUrl("ISSUER", "https://host.example.com/base"), /must be a bare origin/);
  });

  it("rejects a query or fragment", () => {
    assert.throws(() => issuerUrl("ISSUER", "https://host.example.com?a=1"), /must be a bare origin/);
    assert.throws(() => issuerUrl("ISSUER", "https://host.example.com#frag"), /must be a bare origin/);
  });

  it("preserves the operator's exact spelling — an issuer identifier is compared as a string", () => {
    // RFC 8414 §2: issuer identifiers are compared with simple string equality.
    // Canonicalising here (lowercasing, punycoding, dropping :443) would publish
    // a different issuer than the one existing clients cached.
    assert.equal(issuerUrl("ISSUER", "HTTPS://MCP.Example.COM"), "HTTPS://MCP.Example.COM");
    assert.equal(issuerUrl("ISSUER", "https://mcp.example.com:443"), "https://mcp.example.com:443");
  });
});
