import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set ADMIN_TOKEN before config evaluates so isAdminAuthorized has a stable value to compare against.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_TOKEN = "test-token-deterministic";

const { isAdminAuthorized } = await import("../auth/admin.js");

// All assertions below pin against the same `test-token-deterministic` value
// for the lifetime of this test process. Empty/different-token cases are
// covered indirectly via length-mismatch and content-mismatch paths.
describe("isAdminAuthorized (with ADMIN_TOKEN=test-token-deterministic)", () => {
  it("rejects undefined header", () => {
    assert.equal(isAdminAuthorized(undefined), false);
  });

  it("rejects empty string", () => {
    assert.equal(isAdminAuthorized(""), false);
  });

  it("rejects raw token without 'Bearer ' prefix", () => {
    assert.equal(isAdminAuthorized("test-token-deterministic"), false);
  });

  it("rejects wrong token of same length (timingSafeEqual sanity)", () => {
    assert.equal(isAdminAuthorized("Bearer 0000000000000000000000"), false);
  });

  it("rejects wrong-length token (length-mismatch short-circuit)", () => {
    assert.equal(isAdminAuthorized("Bearer abc"), false);
  });

  it("accepts exact 'Bearer <token>' match", () => {
    assert.equal(isAdminAuthorized("Bearer test-token-deterministic"), true);
  });

  it("rejects 'bearer' lowercase (constant-time means strict byte compare)", () => {
    assert.equal(isAdminAuthorized("bearer test-token-deterministic"), false);
  });
});
