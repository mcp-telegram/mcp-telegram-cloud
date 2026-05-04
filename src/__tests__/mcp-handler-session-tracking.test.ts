import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { getActiveSessionsByClient, _trackSessionForTest, _untrackSessionForTest, _resetSessionTrackingForTest } =
  await import("../mcp-handler.js");

describe("mcp-handler — active sessions by client", () => {
  afterEach(() => _resetSessionTrackingForTest());

  it("returns 0 for every class on a fresh state", () => {
    assert.equal(getActiveSessionsByClient("claude"), 0);
    assert.equal(getActiveSessionsByClient("chatgpt"), 0);
    assert.equal(getActiveSessionsByClient("browser"), 0);
    assert.equal(getActiveSessionsByClient("bot"), 0);
    assert.equal(getActiveSessionsByClient("script"), 0);
    assert.equal(getActiveSessionsByClient("empty"), 0);
    assert.equal(getActiveSessionsByClient("other"), 0);
  });

  it("increments per client on session start", () => {
    _trackSessionForTest("sid-a", "claude");
    _trackSessionForTest("sid-b", "claude");
    _trackSessionForTest("sid-c", "chatgpt");
    assert.equal(getActiveSessionsByClient("claude"), 2);
    assert.equal(getActiveSessionsByClient("chatgpt"), 1);
    assert.equal(getActiveSessionsByClient("browser"), 0);
  });

  it("decrements the SAME bucket on session close", () => {
    _trackSessionForTest("sid-a", "chatgpt");
    _trackSessionForTest("sid-b", "chatgpt");
    _untrackSessionForTest("sid-a");
    assert.equal(getActiveSessionsByClient("chatgpt"), 1);
    _untrackSessionForTest("sid-b");
    assert.equal(getActiveSessionsByClient("chatgpt"), 0);
  });

  it("does not go negative if close fires for an unknown sid", () => {
    _untrackSessionForTest("ghost-session");
    // Falls back to 'other'; bucket must stay at 0, not drop to -1.
    assert.equal(getActiveSessionsByClient("other"), 0);
  });

  it("isolates buckets — closing a chatgpt session does not affect claude", () => {
    _trackSessionForTest("c1", "claude");
    _trackSessionForTest("c2", "claude");
    _trackSessionForTest("g1", "chatgpt");
    _untrackSessionForTest("g1");
    assert.equal(getActiveSessionsByClient("claude"), 2);
    assert.equal(getActiveSessionsByClient("chatgpt"), 0);
  });

  it("rejects duplicate-sid track in tests (catches typos)", () => {
    _trackSessionForTest("dup", "claude");
    assert.throws(() => _trackSessionForTest("dup", "chatgpt"), /already tracked/);
    // First track must remain intact — no silent bucket bleed.
    assert.equal(getActiveSessionsByClient("claude"), 1);
    assert.equal(getActiveSessionsByClient("chatgpt"), 0);
  });

  it("untrack is idempotent — second close is a no-op", () => {
    _trackSessionForTest("once", "browser");
    _untrackSessionForTest("once");
    assert.equal(getActiveSessionsByClient("browser"), 0);
    // Second teardown for the same sid (e.g. SDK fired both onclose AND
    // _onsessionclosed for the same session) must not double-decrement.
    _untrackSessionForTest("once");
    assert.equal(getActiveSessionsByClient("browser"), 0);
    assert.equal(getActiveSessionsByClient("other"), 0);
  });
});
