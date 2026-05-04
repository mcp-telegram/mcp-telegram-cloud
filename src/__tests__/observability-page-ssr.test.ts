import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Required env so config.ts (transitive dep of the page) evaluates.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { ObservabilityPage } = await import("../pages/ObservabilityPage.js");

const emptyMetrics = { counters: [], histograms: [], gauges: [] };

/**
 * Regression test for the v2.16.0 → v2.16.1 SSR bug.
 *
 * Symptom: production rendered `ReferenceError: document is not defined`
 * inside `hono/jsx/dom/css.js` when GET /api/observability was hit.
 * Root cause: `<main class={`${card} ${wide}`}>` — concatenating two
 * `css\`...\`` results via template literal forced their `.toString()`
 * through the client-DOM resolver. Fix: use `cx(card, wide)` helper.
 *
 * This test renders the page off the static type — if any future change
 * regresses to template-literal concat of css results (or otherwise
 * trips the `dom/css` Promise path), this test will throw with the same
 * error as production did, catching the bug pre-deploy.
 */
describe("ObservabilityPage SSR", () => {
  it("renders to HTML without throwing (catches dom/css Promise bug)", async () => {
    const node = ObservabilityPage({
      telemetryMode: "on",
      signozEndpointConfigured: true,
      daily: [{ date: "2026-05-03", count: 5 }],
      dau: [{ date: "2026-05-03", activeUsers: 1 }],
      clients: [{ client: "claude", totalCalls: 5, uniqueUsers: 1 }],
      topUsers: [{ userId: "u:abc1234567", totalCalls: 5 }],
      recentErrors: [{ timestamp: "2026-05-03T05:00:00Z", message: "test", attrs: { component: "x" } }],
      metrics: emptyMetrics,
      spans: [],
    });
    const html = await (node as unknown as { toString(): Promise<string> }).toString();
    assert.ok(html.length > 1000, `expected non-trivial HTML, got ${html.length} bytes`);
    assert.ok(html.includes("Telemetry mode"), "expected 'Telemetry mode' label");
    assert.ok(html.includes("Tool calls"), "expected 'Tool calls' section");
    assert.ok(html.includes("u:abc1234567"), "expected hashed userId in top-users table");
  });

  it("renders empty-state cards when no data", async () => {
    const node = ObservabilityPage({
      telemetryMode: "local-only",
      signozEndpointConfigured: false,
      daily: [],
      dau: [],
      clients: [],
      topUsers: [],
      recentErrors: [],
      metrics: emptyMetrics,
      spans: [],
    });
    const html = await (node as unknown as { toString(): Promise<string> }).toString();
    assert.ok(html.includes("No usage recorded yet."));
    assert.ok(html.includes("No client data."));
    assert.ok(html.includes("No users yet."));
    assert.ok(html.includes("No errors recorded since process start."));
  });

  it("renders without warning badge when telemetryMode='on' AND endpoint configured", async () => {
    const node = ObservabilityPage({
      telemetryMode: "on",
      signozEndpointConfigured: true,
      daily: [],
      dau: [],
      clients: [],
      topUsers: [],
      recentErrors: [],
      metrics: emptyMetrics,
      spans: [],
    });
    const html = await (node as unknown as { toString(): Promise<string> }).toString();
    assert.ok(!html.includes("SIGNOZ_ENDPOINT not set"));
  });

  it("renders warning badge when telemetryMode='on' but endpoint NOT configured", async () => {
    const node = ObservabilityPage({
      telemetryMode: "on",
      signozEndpointConfigured: false,
      daily: [],
      dau: [],
      clients: [],
      topUsers: [],
      recentErrors: [],
      metrics: emptyMetrics,
      spans: [],
    });
    const html = await (node as unknown as { toString(): Promise<string> }).toString();
    assert.ok(html.includes("SIGNOZ_ENDPOINT not set"));
  });
});
