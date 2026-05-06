import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const {
  getActiveSessionsByClient,
  reapIdleSessions,
  _trackFullSessionForTest,
  _resetSessionTrackingForTest,
  _setReaperSessionsForTest,
} = await import("../mcp-handler.js");
const { config } = await import("../config.js");

interface MockTransport {
  closeCalls: number;
  close: () => void;
}

function makeTransport(): MockTransport {
  const t: MockTransport = {
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
  };
  return t;
}

describe("mcp-handler — idle reaper", () => {
  afterEach(() => {
    _resetSessionTrackingForTest();
    _setReaperSessionsForTest(null);
  });

  it("does NOT reap sessions whose lastActivity is within threshold", () => {
    const now = 1_000_000_000;
    const transport = makeTransport();
    _trackFullSessionForTest("sid-fresh", "claude", "user-a", transport, now - 1000); // 1s old
    const reaped = reapIdleSessions(now);
    assert.equal(reaped, 0);
    assert.equal(transport.closeCalls, 0);
    assert.equal(getActiveSessionsByClient("claude"), 1);
  });

  it("reaps sessions older than the idle threshold", () => {
    const now = 1_000_000_000;
    const transport = makeTransport();
    const oldEnough = now - config.mcpIdleReapMs - 1;
    _trackFullSessionForTest("sid-stale", "chatgpt", "user-b", transport, oldEnough);

    const reaped = reapIdleSessions(now);
    assert.equal(reaped, 1);
    assert.equal(transport.closeCalls, 1, "transport.close() must fire to drain SSE");
    assert.equal(getActiveSessionsByClient("chatgpt"), 0, "gauge bucket must drop");
  });

  it("reaps only stale sessions, leaves fresh ones untouched", () => {
    const now = 2_000_000_000;
    const stale = makeTransport();
    const fresh = makeTransport();
    _trackFullSessionForTest("sid-stale", "chatgpt", "user-x", stale, now - config.mcpIdleReapMs - 5000);
    _trackFullSessionForTest("sid-fresh", "chatgpt", "user-x", fresh, now - 30_000);

    const reaped = reapIdleSessions(now);
    assert.equal(reaped, 1);
    assert.equal(stale.closeCalls, 1);
    assert.equal(fresh.closeCalls, 0);
    // chatgpt bucket: started at 2 (one per tracked session), -1 from reap = 1
    assert.equal(getActiveSessionsByClient("chatgpt"), 1);
  });

  it("returns 0 when threshold is 0 (reaper disabled)", () => {
    // Save original threshold; we mutate config in-place because intOr-derived
    // numbers are plain mutable fields on the config object.
    const original = config.mcpIdleReapMs;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test-only mutation of a runtime config field
      (config as any).mcpIdleReapMs = 0;
      const transport = makeTransport();
      _trackFullSessionForTest("sid-anything", "claude", "user-z", transport, 0);
      const reaped = reapIdleSessions(Date.now());
      assert.equal(reaped, 0);
      assert.equal(transport.closeCalls, 0);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (config as any).mcpIdleReapMs = original;
    }
  });

  it("survives transport.close() throwing", () => {
    const now = 3_000_000_000;
    const flakyTransport = {
      closeCalls: 0,
      close() {
        this.closeCalls += 1;
        throw new Error("simulated close error");
      },
    };
    _trackFullSessionForTest("sid-flaky", "browser", "user-y", flakyTransport, now - config.mcpIdleReapMs - 1);

    // Must not throw — reaper wraps close() in try/catch.
    const reaped = reapIdleSessions(now);
    assert.equal(reaped, 1);
    assert.equal(flakyTransport.closeCalls, 1);
    // Gauge still drained even if close() errored.
    assert.equal(getActiveSessionsByClient("browser"), 0);
  });

  it("survives transport.close() returning a rejected Promise", async () => {
    const now = 5_000_000_000;
    const asyncFlaky = {
      closeCalls: 0,
      close() {
        this.closeCalls += 1;
        return Promise.reject(new Error("simulated async close error"));
      },
    };
    _trackFullSessionForTest("sid-async-flaky", "browser", "user-q", asyncFlaky, now - config.mcpIdleReapMs - 1);

    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.once("unhandledRejection", onUnhandled);

    const reaped = reapIdleSessions(now);

    // Wait one microtask tick so the rejected promise has a chance to surface.
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", onUnhandled);

    assert.equal(reaped, 1);
    assert.equal(asyncFlaky.closeCalls, 1);
    assert.equal(getActiveSessionsByClient("browser"), 0);
    assert.equal(unhandled, null, "rejected close() must be swallowed by reaper, not escape");
  });

  it("teardown is idempotent — second call for same sid is a no-op", () => {
    const now = 4_000_000_000;
    const transport = makeTransport();
    _trackFullSessionForTest("sid-once", "claude", "user-w", transport, now - config.mcpIdleReapMs - 1);

    const first = reapIdleSessions(now);
    assert.equal(first, 1);
    assert.equal(getActiveSessionsByClient("claude"), 0);

    // Sweep again — no entries left, nothing to reap.
    const second = reapIdleSessions(now);
    assert.equal(second, 0);
    assert.equal(getActiveSessionsByClient("claude"), 0);
  });

  it("reaping the last MCP session for a user calls disconnectUser, NEVER destroyUserSession", () => {
    // Regression for the cross-client logout footgun: idle eviction must NOT
    // logOut() the Telegram session — that would invalidate the auth_key for
    // any other client (Claude/ChatGPT) sharing the same userId.
    const now = 6_000_000_000;
    const calls: string[] = [];
    const fakeSessions = {
      disconnectUser(uid: string) {
        calls.push(`disconnectUser:${uid}`);
      },
      destroyUserSession(uid: string) {
        calls.push(`destroyUserSession:${uid}`);
        return Promise.resolve({ loggedOut: true });
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal duck-typed SessionManager for this test
    _setReaperSessionsForTest(fakeSessions as any);

    const transport = makeTransport();
    _trackFullSessionForTest("sid-last", "chatgpt", "user-shared", transport, now - config.mcpIdleReapMs - 1);

    const reaped = reapIdleSessions(now);
    assert.equal(reaped, 1);
    assert.deepEqual(calls, ["disconnectUser:user-shared"]);
  });
});
