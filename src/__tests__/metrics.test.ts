import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const {
  HTTP_DURATION,
  HTTP_REQUESTS,
  TOOL_CALLS,
  TOOL_DURATION,
  OAUTH_FLOW,
  RATE_LIMIT_HITS,
  classifyExportError,
  incr,
  observe,
  registerGauge,
  snapshot,
  _resetMetricsForTest,
} = await import("../telemetry/metrics.js");

describe("metrics — counters", () => {
  afterEach(() => _resetMetricsForTest());

  it("increments and accumulates per label combination", () => {
    incr(HTTP_REQUESTS, { route: "/mcp", method: "POST", status_class: "2xx", client: "claude" });
    incr(HTTP_REQUESTS, { route: "/mcp", method: "POST", status_class: "2xx", client: "claude" }, 4);
    incr(HTTP_REQUESTS, { route: "/mcp", method: "POST", status_class: "5xx", client: "claude" });

    const snap = snapshot();
    const httpReq = snap.counters.find((c) => c.name === "http.requests");
    assert.ok(httpReq);
    assert.equal(httpReq.points.length, 2);
    const ok = httpReq.points.find((p) => p.labels.status_class === "2xx");
    const fail = httpReq.points.find((p) => p.labels.status_class === "5xx");
    assert.equal(ok?.value, 5);
    assert.equal(fail?.value, 1);
  });

  it("treats different label-key orderings as the same series", () => {
    incr(TOOL_CALLS, { tool: "telegram-list-chats", outcome: "ok" });
    incr(TOOL_CALLS, { outcome: "ok", tool: "telegram-list-chats" });
    const snap = snapshot();
    const def = snap.counters.find((c) => c.name === "mcp.tool.calls");
    assert.equal(def?.points.length, 1);
    assert.equal(def?.points[0]?.value, 2);
  });

  it("each declared counter shows up in snapshot once metrics are recorded", () => {
    incr(OAUTH_FLOW, { step: "authorize", outcome: "qr_page" });
    incr(RATE_LIMIT_HITS, { tier: "free", tool: "telegram-list-chats" });
    const active = snapshot()
      .counters.flatMap((c) => (c.points.length > 0 ? [c.name] : []))
      .sort();
    assert.deepEqual(active, ["oauth.flow", "rate_limit.hits"]);
  });
});

describe("metrics — histograms", () => {
  afterEach(() => _resetMetricsForTest());

  it("buckets values and tracks count + sum", () => {
    observe(HTTP_DURATION, 7, { route: "/health", method: "GET", status_class: "2xx" });
    observe(HTTP_DURATION, 30, { route: "/health", method: "GET", status_class: "2xx" });
    observe(HTTP_DURATION, 1500, { route: "/health", method: "GET", status_class: "2xx" });

    const snap = snapshot();
    const def = snap.histograms.find((h) => h.name === "http.duration");
    assert.ok(def);
    const point = def.points[0];
    assert.equal(point.count, 3);
    assert.equal(point.sum, 1537);
    // Boundaries [5,10,25,50,100,250,500,1000,2500,5000,10000].
    // 7 → bucket index 1 (≤10), 30 → index 3 (≤50), 1500 → index 8 (≤2500).
    assert.equal(point.buckets[1], 1);
    assert.equal(point.buckets[3], 1);
    assert.equal(point.buckets[8], 1);
  });

  it("places overflow values in the +Inf bucket", () => {
    observe(TOOL_DURATION, 60_000, { tool: "telegram-status", outcome: "ok" });
    const snap = snapshot();
    const def = snap.histograms.find((h) => h.name === "mcp.tool.duration");
    assert.ok(def);
    const point = def.points[0];
    // TOOL boundaries length = 9 → +Inf is at index 9
    assert.equal(point.buckets[9], 1);
    assert.equal(point.count, 1);
  });
});

describe("metrics — gauges", () => {
  afterEach(() => _resetMetricsForTest());

  it("reads provider value at snapshot time", () => {
    let counter = 0;
    registerGauge("test.counter", "test", () => ++counter);
    const snap = snapshot();
    const g = snap.gauges.find((x) => x.name === "test.counter");
    assert.ok(g);
    assert.equal(g.points.length, 1);
    assert.equal(g.points[0]?.value, 1);
    // Next snapshot reads again (lazy provider).
    assert.equal(snapshot().gauges.find((x) => x.name === "test.counter")?.points[0]?.value, 2);
  });

  it("never throws when a gauge provider throws — returns 0", () => {
    registerGauge("test.broken", "test", () => {
      throw new Error("boom");
    });
    const snap = snapshot();
    const g = snap.gauges.find((x) => x.name === "test.broken");
    assert.equal(g?.points[0]?.value, 0);
  });

  it("reads each provider exactly once per snapshot() call", () => {
    let calls = 0;
    registerGauge("test.once", "test", () => {
      calls += 1;
      return calls;
    });
    snapshot();
    assert.equal(calls, 1);
  });
});

const { flushMetrics } = await import("../telemetry/metrics.js");

describe("metrics — OTLP gating (H1)", () => {
  afterEach(() => {
    _resetMetricsForTest();
    delete process.env.MCP_TELEGRAM_TELEMETRY;
    delete process.env.SIGNOZ_ENDPOINT;
  });

  // Each test seeds at least one data point so flushMetrics() doesn't early-return on `hasData=false`.
  it("flushMetrics() skips fetch when telemetryMode != 'on'", async () => {
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("");
    };
    try {
      // Default config.telemetryMode is "local-only" (set at module load before this test imports anything).
      await flushMetrics();
      assert.equal(fetchCalls, 0, "must not fetch when telemetryMode='local-only'");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("flushMetrics() skips fetch when SIGNOZ_ENDPOINT is empty even if mode='on'", async () => {
    // Mutate config object directly — the otlpActive() helper reads it dynamically (post-H1 fix).
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "";
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("");
    };
    try {
      await flushMetrics();
      assert.equal(fetchCalls, 0, "must not fetch when endpoint is empty");
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
    }
  });

  it("flushMetrics() POSTs to /v1/metrics when mode='on' AND endpoint set", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    const captured: { url: string; body: string } = { url: "", body: "" };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured.url = String(url);
      captured.body = String((init as RequestInit).body);
      return new Response("");
    };
    try {
      await flushMetrics();
      assert.equal(captured.url, "https://signoz.test/v1/metrics");
      assert.ok(captured.body.includes("http.requests"));
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
    }
  });

  it("flushMetrics() omits Authorization header when SIGNOZ_AUTH is empty (backward-compat)", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    const origAuth = cfg.signozAuth;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";
    (cfg as { signozAuth: string }).signozAuth = "";
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    const captured: { headers: Record<string, string> } = { headers: {} };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await flushMetrics();
      assert.equal(captured.headers["Content-Type"], "application/json");
      assert.equal(captured.headers.Authorization, undefined, "no Authorization when auth empty");
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
      (cfg as { signozAuth: string }).signozAuth = origAuth;
    }
  });

  it("flushMetrics() emits Basic Authorization header when SIGNOZ_AUTH is set", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    const origAuth = cfg.signozAuth;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";
    (cfg as { signozAuth: string }).signozAuth = "ingest-user:s3cret-pw";
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    const captured: { headers: Record<string, string> } = { headers: {} };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await flushMetrics();
      const expected = `Basic ${Buffer.from("ingest-user:s3cret-pw").toString("base64")}`;
      assert.equal(captured.headers.Authorization, expected);
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
      (cfg as { signozAuth: string }).signozAuth = origAuth;
    }
  });

  it("concurrent flushMetrics() callers share the same in-flight promise (regression: copilot pass-2 MEDIUM)", async () => {
    // Pre-fix bug: a second flushMetrics() call returned immediately when
    // `flushInFlight` was true, so a SIGTERM landing mid-export saw `await
    // flushMetrics()` no-op and exit before the POST finished — losing the tail.
    // Fix: track the in-flight promise; later callers await the same one.
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";

    incr(TOOL_CALLS, { tool: "telegram-status", outcome: "ok" });
    let posts = 0;
    let resolveFetch: () => void = () => {};
    const fetchPromise = new Promise<void>((r) => {
      resolveFetch = r;
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      posts += 1;
      await fetchPromise; // simulate slow SigNoz
      return new Response("");
    };

    try {
      const a = flushMetrics(); // starts the export, blocks on fetchPromise
      const b = flushMetrics(); // SIGTERM-style second caller — must await the same export
      // Resolve the first export.
      resolveFetch();
      await Promise.all([a, b]);
      assert.equal(posts, 1, "exactly one POST — second caller awaited the same in-flight promise");
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
    }
  });

  it("graceful shutdown drains the tail before exit (regression: copilot pass-1 MEDIUM)", async () => {
    // Mirrors src/server.tsx SIGTERM handler order:
    // stopMetricsFlush(); await flushMetrics(); await logger.flush(); exit
    // Without the explicit flushMetrics() after stop, tail data accumulated since
    // the last 15s tick was silently dropped on every deploy.
    const { config: cfg } = await import("../config.js");
    const { stopMetricsFlush, startMetricsFlush } = await import("../telemetry/metrics.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";

    incr(TOOL_CALLS, { tool: "telegram-status", outcome: "ok" });
    let posts = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      posts += 1;
      return new Response("");
    };

    try {
      startMetricsFlush();
      stopMetricsFlush();
      await flushMetrics();
      assert.equal(posts, 1, "shutdown must POST exactly once after stopMetricsFlush()");
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
    }
  });
});

describe("metrics — classifyExportError (cardinality-bounded reasons)", () => {
  it("maps 401/403 → auth_failed", () => {
    assert.equal(classifyExportError(new Response("", { status: 401 })), "auth_failed");
    assert.equal(classifyExportError(new Response("", { status: 403 })), "auth_failed");
  });

  it("maps 5xx → server_error", () => {
    assert.equal(classifyExportError(new Response("", { status: 500 })), "server_error");
    assert.equal(classifyExportError(new Response("", { status: 503 })), "server_error");
  });

  it("maps non-auth 4xx → client_error", () => {
    assert.equal(classifyExportError(new Response("", { status: 400 })), "client_error");
    assert.equal(classifyExportError(new Response("", { status: 404 })), "client_error");
  });

  it("maps AbortError/TimeoutError/TypeError throws → network", () => {
    const ab = new Error("aborted");
    ab.name = "AbortError";
    assert.equal(classifyExportError(ab), "network");
    const to = new Error("timeout");
    to.name = "TimeoutError";
    assert.equal(classifyExportError(to), "network");
    const t = new TypeError("fetch failed");
    assert.equal(classifyExportError(t), "network");
  });

  it("maps unknown shapes → unknown", () => {
    // Anything that isn't a Response or a recognized Error.name falls through.
    assert.equal(classifyExportError("string error"), "unknown");
    assert.equal(classifyExportError(undefined), "unknown");
    assert.equal(classifyExportError({ message: "raw object" }), "unknown");
    // Generic Error (no AbortError/TimeoutError/TypeError name) also unknown.
    assert.equal(classifyExportError(new Error("generic")), "unknown");
  });
});

describe("metrics — TELEMETRY_EXPORT_ERRORS counter (silent-fail visibility)", () => {
  afterEach(() => {
    _resetMetricsForTest();
    delete process.env.MCP_TELEGRAM_TELEMETRY;
    delete process.env.SIGNOZ_ENDPOINT;
  });

  it("flushMetrics() increments counter with reason=auth_failed when SigNoz returns 401", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    try {
      await flushMetrics();
      const errs = snapshot().counters.find((c) => c.name === "telemetry.export.errors");
      assert.ok(errs, "telemetry.export.errors counter exists in snapshot");
      const auth = errs.points.find((p) => p.labels.signal === "metrics" && p.labels.reason === "auth_failed");
      assert.ok(auth, "auth_failed point exists for signal=metrics");
      assert.equal(auth.value, 1);
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
    }
  });

  it("flushMetrics() increments counter with reason=network when fetch rejects (timeout)", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    try {
      await flushMetrics();
      const errs = snapshot().counters.find((c) => c.name === "telemetry.export.errors");
      const net = errs?.points.find((p) => p.labels.signal === "metrics" && p.labels.reason === "network");
      assert.ok(net, "network point exists for signal=metrics");
      assert.equal(net.value, 1);
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
    }
  });

  it("flushMetrics() does NOT increment counter on 200 OK (success path stays clean)", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origEndpoint = cfg.signozEndpoint;
    (cfg as { telemetryMode: string }).telemetryMode = "on";
    (cfg as { signozEndpoint: string }).signozEndpoint = "https://signoz.test";
    incr(HTTP_REQUESTS, { route: "/health", method: "GET", status_class: "2xx", client: "browser" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 200 });
    try {
      await flushMetrics();
      const errs = snapshot().counters.find((c) => c.name === "telemetry.export.errors");
      // Counter is declared so it's in the catalog, but with no points (or all values=0).
      const total = errs?.points.reduce((s, p) => s + p.value, 0) ?? 0;
      assert.equal(total, 0, "no errors recorded on success");
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
      (cfg as { signozEndpoint: string }).signozEndpoint = origEndpoint;
    }
  });
});
