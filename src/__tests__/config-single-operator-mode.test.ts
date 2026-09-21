process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("config.singleOperatorMode", () => {
  it("defaults to false when SINGLE_OPERATOR_MODE is unset", async () => {
    // isolated env: this file doesn't set SINGLE_OPERATOR_MODE at all
    const { config } = await import("../config.js");
    assert.equal(config.singleOperatorMode, false);
  });
});
