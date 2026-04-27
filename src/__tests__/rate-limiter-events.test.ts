import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PREFIX, parseEvent, truncate } from "../rate-limiter-events-parser.js";

describe("parseEvent", () => {
  it("parses a flood_wait line", () => {
    const line = `${PREFIX}{"event":"flood_wait","context":"list-chats","seconds":30,"attempt":1,"maxRetries":3}`;
    const result = parseEvent(line);
    assert.deepEqual(result, {
      event: "flood_wait",
      context: "list-chats",
      seconds: 30,
      attempt: 1,
      maxRetries: 3,
    });
  });

  it("parses a network_retry line with delayMs and error", () => {
    const line = `${PREFIX}{"event":"network_retry","context":"send-message","delayMs":2000,"attempt":2,"maxRetries":3,"error":"ETIMEDOUT"}`;
    const result = parseEvent(line);
    assert.equal(result?.event, "network_retry");
    assert.equal(result?.delayMs, 2000);
    assert.equal(result?.error, "ETIMEDOUT");
  });

  it("parses a temporary_retry line", () => {
    const line = `${PREFIX}{"event":"temporary_retry","context":"get-profile","delayMs":1000,"attempt":1,"maxRetries":3,"error":"503"}`;
    const result = parseEvent(line);
    assert.equal(result?.event, "temporary_retry");
  });

  it("returns null for malformed JSON", () => {
    const line = `${PREFIX}{"event":"flood_wait","context":`;
    assert.equal(parseEvent(line), null);
  });

  it("returns null when required fields are missing", () => {
    const line = `${PREFIX}{"event":"flood_wait"}`;
    assert.equal(parseEvent(line), null);
  });

  it("returns null for unknown event types", () => {
    const line = `${PREFIX}{"event":"mystery","context":"x","attempt":1,"maxRetries":3}`;
    assert.equal(parseEvent(line), null);
  });

  it("returns null when types are wrong", () => {
    const line = `${PREFIX}{"event":"flood_wait","context":"x","attempt":"one","maxRetries":3}`;
    assert.equal(parseEvent(line), null);
  });

  it("tolerates trailing whitespace", () => {
    const line = `${PREFIX}{"event":"flood_wait","context":"x","attempt":1,"maxRetries":3}   `;
    assert.equal(parseEvent(line)?.event, "flood_wait");
  });

  it("returns null (does not throw) for valid JSON that is not an object", () => {
    assert.equal(parseEvent(`${PREFIX}null`), null);
    assert.equal(parseEvent(`${PREFIX}"string"`), null);
    assert.equal(parseEvent(`${PREFIX}42`), null);
    assert.equal(parseEvent(`${PREFIX}[]`), null);
    assert.equal(parseEvent(`${PREFIX}true`), null);
  });

  it("drops optional fields with wrong types instead of admitting them", () => {
    const line = `${PREFIX}{"event":"flood_wait","context":"x","attempt":1,"maxRetries":3,"seconds":"30","delayMs":"5","error":42}`;
    const result = parseEvent(line);
    assert.ok(result);
    assert.equal(result.seconds, undefined);
    assert.equal(result.delayMs, undefined);
    assert.equal(result.error, undefined);
  });

  it("preserves valid optional fields", () => {
    const line = `${PREFIX}{"event":"network_retry","context":"x","attempt":1,"maxRetries":3,"delayMs":2000,"error":"ETIMEDOUT"}`;
    const result = parseEvent(line);
    assert.equal(result?.delayMs, 2000);
    assert.equal(result?.error, "ETIMEDOUT");
  });
});

describe("truncate", () => {
  it("returns the string unchanged when within max", () => {
    assert.equal(truncate("hello", 10), "hello");
    assert.equal(truncate("hello", 5), "hello");
  });

  it("truncates and appends an ellipsis when over max", () => {
    const long = "a".repeat(250);
    const result = truncate(long, 200);
    assert.equal(result.length, 201);
    assert.equal(result, `${"a".repeat(200)}…`);
  });

  it("handles empty string", () => {
    assert.equal(truncate("", 10), "");
  });
});
