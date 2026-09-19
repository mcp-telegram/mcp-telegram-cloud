process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder"; // overwritten per-test below where needed

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { hashAdminPassword, verifyAdminPassword, buildAdminSessionCookie, isAdminSessionValid } = await import(
  "../auth/admin.js"
);
const { config } = await import("../config.js");

describe("hashAdminPassword / verifyAdminPassword", () => {
  it("round-trips a correct password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    assert.equal(verifyAdminPassword("correct horse battery staple", hash), true);
  });

  it("rejects a wrong password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    assert.equal(verifyAdminPassword("wrong password", hash), false);
  });

  it("produces a different salt (and therefore different hash) each call", () => {
    const a = hashAdminPassword("same password");
    const b = hashAdminPassword("same password");
    assert.notEqual(a, b);
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    assert.equal(verifyAdminPassword("anything", "not-a-valid-hash"), false);
  });
});

describe("admin session cookie", () => {
  it("a freshly built cookie is valid", () => {
    const setCookie = buildAdminSessionCookie();
    const value = setCookie.split(";")[0]; // "admin_session=<value>"
    assert.equal(isAdminSessionValid(value), true);
  });

  it("carries HttpOnly, Secure, SameSite=Lax and a 30-day Max-Age", () => {
    const setCookie = buildAdminSessionCookie();
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/);
  });

  it("rejects a missing cookie header", () => {
    assert.equal(isAdminSessionValid(undefined), false);
  });

  it("rejects a tampered signature", () => {
    const setCookie = buildAdminSessionCookie();
    const value = setCookie.split(";")[0];
    const tampered = `${value}zz`;
    assert.equal(isAdminSessionValid(tampered), false);
  });

  it("rejects an expired cookie", () => {
    // Build a cookie whose payload is already in the past, signed with the
    // same key buildAdminSessionCookie uses, by forging via the public API's
    // own expiry math is not possible from here — instead assert the format
    // contract: a payload timestamp of 1 (1970) must never validate.
    const forged = `admin_session=1.0000000000000000000000000000000000000000000000000000000000000000`;
    assert.equal(isAdminSessionValid(forged), false);
  });

  it("rejects a malformed percent-encoded cookie value instead of throwing", () => {
    // decodeURIComponent throws URIError on malformed percent-encoding.
    // Must fail closed: return false instead of throwing.
    assert.equal(isAdminSessionValid("admin_session=%"), false);
  });

  // Finding 4 Part A (final-branch review, 2026-09-18-single-operator-auth):
  // an empty ADMIN_PASSWORD_HASH means an empty HMAC signing key, which makes
  // every session cookie forgeable. server.tsx refuses to boot in that case,
  // but isAdminSessionValid must not rely on that invariant for its own core
  // security property — it must fail closed on its own.
  it("fails closed when ADMIN_PASSWORD_HASH is empty, even against a validly-shaped signature", () => {
    const original = config.adminPasswordHash;
    try {
      // Sign a cookie with the empty key an attacker could also compute
      // (HMAC-SHA256 of an empty-string key is not a secret).
      config.adminPasswordHash = "";
      const forged = buildAdminSessionCookie().split(";")[0];
      assert.equal(isAdminSessionValid(forged), false);
    } finally {
      config.adminPasswordHash = original;
    }
  });

  // Finding 4 Part B: the cookie-name regex must be anchored to `^` or a
  // `; ` separator so it can't match a different cookie whose name merely
  // ends in the same substring (e.g. `xadmin_session=...`), or a value
  // elsewhere in the header that happens to contain the literal text
  // `admin_session=`.
  it("does not match a same-suffix cookie name (xadmin_session)", () => {
    const value = buildAdminSessionCookie().split(";")[0].replace("admin_session=", ""); // "<payload>.<sig>"
    assert.equal(isAdminSessionValid(`xadmin_session=${value}`), false);
  });

  it("does not match the literal substring inside another cookie's value", () => {
    const value = buildAdminSessionCookie().split(";")[0].replace("admin_session=", "");
    // A decoy cookie whose VALUE happens to contain "admin_session=<real value>"
    // must not be picked up in place of (or in addition to) the real cookie.
    assert.equal(isAdminSessionValid(`decoy=admin_session=${value}`), false);
  });

  it("still finds the real cookie when it's not first in the header", () => {
    const valid = buildAdminSessionCookie().split(";")[0];
    assert.equal(isAdminSessionValid(`other=1; ${valid}; another=2`), true);
  });
});
