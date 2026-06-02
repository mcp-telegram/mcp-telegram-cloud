import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

// Required for config.ts to evaluate when static.tsx pulls it in.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { _resetDrainingFlagForTest, startDrain } = await import("../lifecycle.js");
const { createStaticRoutes } = await import("../routes/static.js");
type SessionManager = import("../session-manager.js").SessionManager;

/** Minimal SessionManager stub — /health only reads getActiveCount(). */
function stubSessions(activeCount: number): SessionManager {
  return { getActiveCount: () => activeCount } as unknown as SessionManager;
}

describe("/health endpoint", () => {
  afterEach(() => {
    _resetDrainingFlagForTest();
  });

  it("returns 200 + status=ok when not draining", async () => {
    const app = createStaticRoutes({ sessions: stubSessions(3) });
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; activeSessions: number; activeMcpSessions: number };
    assert.equal(body.status, "ok");
    assert.equal(body.activeSessions, 3);
    assert.equal(typeof body.activeMcpSessions, "number");
  });

  it("returns 503 + status=draining once startDrain begins", async () => {
    // Kick off a drain but don't await it — we just need the flag flipped.
    void startDrain({
      healthDelayMs: 999_999,
      timeoutMs: 999_999,
      pollMs: 999_999,
      activeSessions: () => 0,
      sleep: () => new Promise(() => {}), // never resolves — test only inspects the flag
    });
    // Microtask flush — startDrain sets the flag synchronously before its first await.
    await Promise.resolve();

    const app = createStaticRoutes({ sessions: stubSessions(2) });
    const res = await app.request("/health");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string; activeSessions: number };
    assert.equal(body.status, "draining");
    assert.equal(body.activeSessions, 2);
  });
});

describe("/robots.txt", () => {
  it("disallows all crawlers", async () => {
    const app = createStaticRoutes({ sessions: stubSessions(0) });
    const res = await app.request("/robots.txt");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    assert.equal(await res.text(), "User-agent: *\nDisallow: /\n");
  });
});

describe("/app-assets/* static serving", () => {
  it("404s an unknown asset", async () => {
    const app = createStaticRoutes({ sessions: stubSessions(0) });
    const res = await app.request("/app-assets/assets/does-not-exist.js");
    assert.equal(res.status, 404);
  });

  it("404s a path-traversal attempt instead of leaking files", async () => {
    const app = createStaticRoutes({ sessions: stubSessions(0) });
    const res = await app.request("/app-assets/..%2f..%2f..%2fetc%2fpasswd");
    assert.equal(res.status, 404);
  });
});
