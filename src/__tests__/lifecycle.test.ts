import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

// lifecycle → mcp-handler → config pulls in required env vars at module load.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { _resetDrainingFlagForTest, isDraining, startDrain } = await import("../lifecycle.js");

/** Fake clock — accumulates virtual ms instead of really sleeping, so the
 *  60s default timeout doesn't slow the test suite. */
function fakeSleeper() {
  let virtualMs = 0;
  return {
    sleep: (ms: number) => {
      virtualMs += ms;
      return Promise.resolve();
    },
    now: () => virtualMs,
  };
}

describe("lifecycle.startDrain", () => {
  afterEach(() => {
    _resetDrainingFlagForTest();
  });

  it("isDraining flips to true once startDrain begins", async () => {
    assert.equal(isDraining(), false);
    const clock = fakeSleeper();
    const events: string[] = [];
    const drainPromise = startDrain({
      healthDelayMs: 100,
      timeoutMs: 1000,
      pollMs: 50,
      activeSessions: () => 0,
      sleep: clock.sleep,
      onProgress: (e) => events.push(e),
    });
    // Microtask tick — the flag is set synchronously before the first await.
    await Promise.resolve();
    assert.equal(isDraining(), true);
    await drainPromise;
    assert.deepEqual(events, ["start", "health-delay-done", "drained"]);
  });

  it("exits early with outcome=drained once active sessions hit zero", async () => {
    const clock = fakeSleeper();
    let active = 3;
    const reader = () => active;
    // After the health-delay, simulate one client closing per poll until zero.
    let polls = 0;
    const result = await startDrain({
      healthDelayMs: 50,
      timeoutMs: 100_000,
      pollMs: 10,
      activeSessions: () => {
        const v = reader();
        polls += 1;
        // Caller reads on entry to wait-loop, then again after each sleep.
        // Drop one client every two reads to mirror real-world close cadence.
        if (polls % 2 === 0 && active > 0) active -= 1;
        return v;
      },
      sleep: clock.sleep,
    });
    assert.equal(result.outcome, "drained");
    assert.equal(result.remaining, 0);
  });

  it("exits with outcome=timeout when sessions never drop to zero", async () => {
    const clock = fakeSleeper();
    const result = await startDrain({
      healthDelayMs: 100,
      timeoutMs: 500,
      pollMs: 50,
      activeSessions: () => 2,
      sleep: clock.sleep,
    });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.remaining, 2);
  });

  it("is idempotent — second call no-ops with current state", async () => {
    const clock = fakeSleeper();
    await startDrain({
      healthDelayMs: 10,
      timeoutMs: 100,
      pollMs: 10,
      activeSessions: () => 0,
      sleep: clock.sleep,
    });
    assert.equal(isDraining(), true);

    // Second call must not reset the flag, hang, or re-emit progress events.
    const events: string[] = [];
    const second = await startDrain({
      healthDelayMs: 999_999,
      timeoutMs: 999_999,
      pollMs: 999_999,
      activeSessions: () => 7,
      sleep: clock.sleep,
      onProgress: (e) => events.push(e),
    });
    assert.equal(second.outcome, "drained");
    assert.equal(second.remaining, 7);
    assert.deepEqual(events, [], "second startDrain must not emit progress");
  });
});
