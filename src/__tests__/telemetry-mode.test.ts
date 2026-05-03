import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Required env so config.ts evaluates.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { parseTelemetryMode, config } = await import("../config.js");

describe("parseTelemetryMode", () => {
  it("accepts 'on'", () => assert.equal(parseTelemetryMode("on"), "on"));
  it("accepts 'off'", () => assert.equal(parseTelemetryMode("off"), "off"));
  it("accepts 'local-only'", () => assert.equal(parseTelemetryMode("local-only"), "local-only"));

  it("trims whitespace", () => assert.equal(parseTelemetryMode("  on  "), "on"));
  it("lowercases input", () => assert.equal(parseTelemetryMode("LOCAL-ONLY"), "local-only"));

  it("undefined → local-only (privacy by default)", () => assert.equal(parseTelemetryMode(undefined), "local-only"));
  it("empty string → local-only", () => assert.equal(parseTelemetryMode(""), "local-only"));
  it("garbage → local-only (no silent enable)", () => {
    assert.equal(parseTelemetryMode("yes"), "local-only");
    assert.equal(parseTelemetryMode("true"), "local-only");
    assert.equal(parseTelemetryMode("1"), "local-only");
    assert.equal(parseTelemetryMode("enabled"), "local-only");
  });
});

describe("config exports", () => {
  it("config.telemetryMode is a valid TelemetryMode", () => {
    assert.ok(["on", "off", "local-only"].includes(config.telemetryMode));
  });

  it("config.logUserIds is boolean and defaults to false (feedback_env_default_semantics.md)", () => {
    assert.equal(typeof config.logUserIds, "boolean");
    if (process.env.LOG_USER_IDS === "true") {
      assert.equal(config.logUserIds, true);
    } else {
      // Anything other than literal "true" (unset, "false", "yes", garbage) → false.
      assert.equal(config.logUserIds, false);
    }
  });
});
