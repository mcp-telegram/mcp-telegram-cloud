import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Importing config.ts triggers required-env validation on load. Set the
// minimum so the module evaluates; the test only exercises the exported
// httpUrl helper, not the full config object.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { httpUrl } = await import("../config.js");

describe("httpUrl", () => {
  it("accepts an https URL", () => {
    assert.equal(httpUrl("X", "https://example.com/path"), "https://example.com/path");
  });

  it("accepts a plain http URL (allowed for local dev)", () => {
    assert.equal(httpUrl("X", "http://localhost:3000"), "http://localhost:3000");
  });

  it("rejects javascript: scheme (XSS guard)", () => {
    assert.throws(() => httpUrl("X", "javascript:alert(1)"), /must be an http\(s\) URL/);
  });

  it("rejects data: scheme", () => {
    assert.throws(() => httpUrl("X", "data:text/html,<script>"), /must be an http\(s\) URL/);
  });

  it("rejects file: scheme", () => {
    assert.throws(() => httpUrl("X", "file:///etc/passwd"), /must be an http\(s\) URL/);
  });

  it("rejects malformed URL strings", () => {
    assert.throws(() => httpUrl("X", "not a url"), /not a valid URL/);
    assert.throws(() => httpUrl("X", ""), /not a valid URL/);
  });

  it("includes the env var name in the error so misconfig is debuggable", () => {
    try {
      httpUrl("MY_BAD_VAR", "ftp://example");
      assert.fail("expected throw");
    } catch (err) {
      assert.match(String(err), /MY_BAD_VAR/);
    }
  });
});
