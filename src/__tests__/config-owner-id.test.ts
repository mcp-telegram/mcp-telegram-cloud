process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "s1:deadbeef:deadbeef";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { ownerUserIdFor, config } = await import("../config.js");

describe("ownerUserIdFor", () => {
  it("derives a fixed, non-guessable-looking owner id from the admin username", () => {
    assert.equal(ownerUserIdFor("alice"), "admin:alice");
  });

  it("is stable across calls (used as a DB primary key everywhere)", () => {
    assert.equal(ownerUserIdFor("bob"), ownerUserIdFor("bob"));
  });
});

describe("config.ownerUserId", () => {
  it("is derived from ADMIN_USERNAME at boot", () => {
    assert.equal(config.ownerUserId, "admin:alice");
  });

  it("exposes the raw admin credentials for auth/admin.ts to check against", () => {
    assert.equal(config.adminUsername, "alice");
    assert.equal(config.adminPasswordHash, "s1:deadbeef:deadbeef");
  });
});
