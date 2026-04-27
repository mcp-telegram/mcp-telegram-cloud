import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The installer transitively imports config.ts (via logger.ts) which throws
// at import-time when required env vars are missing. Set them BEFORE the
// dynamic import so module evaluation succeeds in a bare test environment.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "http://localhost:3000";

const { installRateLimiterEventListener } = await import("../rate-limiter-events.js");
const { PREFIX } = await import("../rate-limiter-events-parser.js");

// The installer uses a module-level `installed` flag, so it can only be
// effectively wired once per process. Both invariants below are therefore
// asserted from a single install + a second (idempotent) install call.
describe("installRateLimiterEventListener", () => {
  it("always delegates to the original console.error and is idempotent", () => {
    const originalConsoleError = console.error;
    const calls: unknown[][] = [];
    // Install spy FIRST, then call installer. The installer then captures our
    // spy as `originalError` and must delegate to it for every line. If the
    // wrapper ever stops delegating, `calls.length` will under-count.
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      installRateLimiterEventListener();
      // Second call must be a no-op — it must NOT stack another wrapper, or
      // each console.error invocation would push duplicate entries into calls.
      installRateLimiterEventListener();

      const validLine = `${PREFIX}{"event":"flood_wait","context":"x","attempt":1,"maxRetries":3,"seconds":1}`;
      const brokenLine = `${PREFIX}{"event":"flood_wait","context":`;
      const unrelatedLine = "unrelated stderr line";

      console.error(validLine);
      console.error(brokenLine);
      console.error(unrelatedLine, { extra: 1 });

      assert.equal(
        calls.length,
        3,
        "every call must reach the original console.error exactly once (delegation + idempotence)",
      );
      assert.equal(calls[0]?.[0], validLine);
      assert.equal(calls[1]?.[0], brokenLine);
      assert.equal(calls[2]?.[0], unrelatedLine);
      assert.deepEqual(calls[2]?.[1], { extra: 1 });
    } finally {
      console.error = originalConsoleError;
    }
  });
});
