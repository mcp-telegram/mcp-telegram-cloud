process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";
process.env.SINGLE_OPERATOR_MODE ??= "true";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("config.singleOperatorMode enabled", () => {
  it("is true when SINGLE_OPERATOR_MODE=true", async () => {
    const { config } = await import("../config.js");
    assert.equal(config.singleOperatorMode, true);
  });
});
