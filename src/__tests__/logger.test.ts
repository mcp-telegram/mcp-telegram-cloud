import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
// Set telemetry on at boot so the auth-header tests below see flush() take
// the egress path. The kill-switch is now re-read per call (v2.21.1), so
// individual tests can also override `config.telemetryMode` at runtime.
process.env.MCP_TELEGRAM_TELEMETRY = "on";
process.env.SIGNOZ_ENDPOINT = "https://signoz.test";

const { logger } = await import("../logger.js");

describe("logger — OTLP auth header (mirrors metrics.ts auth tests)", () => {
  it("flush() omits Authorization header when SIGNOZ_AUTH is empty (backward-compat)", async () => {
    const { config: cfg } = await import("../config.js");
    const origAuth = cfg.signozAuth;
    (cfg as { signozAuth: string }).signozAuth = "";
    logger.info("seed", { component: "test" });
    const captured: { headers: Record<string, string> } = { headers: {} };
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (_url: string | URL | Request, init: RequestInit | undefined) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await logger.flush();
      assert.equal(captured.headers["Content-Type"], "application/json");
      assert.equal(captured.headers.Authorization, undefined, "no Authorization when auth empty");
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      (cfg as { signozAuth: string }).signozAuth = origAuth;
    }
  });

  it("flush() emits Basic Authorization header when SIGNOZ_AUTH is set", async () => {
    const { config: cfg } = await import("../config.js");
    const origAuth = cfg.signozAuth;
    (cfg as { signozAuth: string }).signozAuth = "ingest-user:s3cret-pw";
    logger.info("seed", { component: "test" });
    const captured: { headers: Record<string, string> } = { headers: {} };
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (_url: string | URL | Request, init: RequestInit | undefined) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await logger.flush();
      const expected = `Basic ${Buffer.from("ingest-user:s3cret-pw").toString("base64")}`;
      assert.equal(captured.headers.Authorization, expected);
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      (cfg as { signozAuth: string }).signozAuth = origAuth;
    }
  });
});

describe("logger — TELEMETRY_EXPORT_ERRORS on bad status / throw", () => {
  it("flush() increments counter with signal=logs reason=auth_failed when SigNoz returns 401", async () => {
    const { TELEMETRY_EXPORT_ERRORS, snapshot, _resetMetricsForTest } = await import("../telemetry/metrics.js");
    _resetMetricsForTest();
    logger.info("seed", { component: "test" });
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => new Response("Unauthorized", { status: 401 });
    try {
      await logger.flush();
      const errs = snapshot().counters.find((c) => c.name === "telemetry.export.errors");
      assert.ok(errs, "counter declared");
      const auth = errs.points.find((p) => p.labels.signal === "logs" && p.labels.reason === "auth_failed");
      assert.ok(auth, "auth_failed point exists for signal=logs");
      assert.equal(auth.value, 1);
      // Reference TELEMETRY_EXPORT_ERRORS to keep its definition reachable in tests.
      assert.equal(TELEMETRY_EXPORT_ERRORS.name, "telemetry.export.errors");
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      _resetMetricsForTest();
    }
  });

  it("flush() increments counter with signal=logs reason=network when fetch throws", async () => {
    const { snapshot, _resetMetricsForTest } = await import("../telemetry/metrics.js");
    _resetMetricsForTest();
    logger.info("seed", { component: "test" });
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    try {
      await logger.flush();
      const errs = snapshot().counters.find((c) => c.name === "telemetry.export.errors");
      const net = errs?.points.find((p) => p.labels.signal === "logs" && p.labels.reason === "network");
      assert.ok(net, "network point exists for signal=logs");
      assert.equal(net.value, 1);
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      _resetMetricsForTest();
    }
  });

  it("flush() attaches traceId/spanId from active span to LogRecord (Phase C correlation)", async () => {
    const { withSpan, _resetTracerForTest } = await import("../telemetry/tracer.js");
    _resetTracerForTest();
    const captured: { records: Array<{ traceId?: string; spanId?: string }> } = { records: [] };
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (_url: string | URL | Request, init: RequestInit | undefined) => {
      const body = JSON.parse((init as RequestInit).body as string);
      captured.records = body.resourceLogs[0].scopeLogs[0].logRecords;
      return new Response("");
    };
    try {
      await withSpan("fixture-span", {}, async () => {
        logger.info("inside-span", { component: "test" });
      });
      // Log AFTER the span ended — must carry no trace context.
      logger.info("outside-span", { component: "test" });
      await logger.flush();
      assert.equal(captured.records.length, 2);
      assert.match(captured.records[0].traceId ?? "", /^[0-9a-f]{32}$/, "in-span log carries traceId");
      assert.match(captured.records[0].spanId ?? "", /^[0-9a-f]{16}$/, "in-span log carries spanId");
      assert.equal(captured.records[1].traceId, undefined, "out-of-span log has no traceId");
      assert.equal(captured.records[1].spanId, undefined, "out-of-span log has no spanId");
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      _resetTracerForTest();
    }
  });
});

describe("logger — runtime kill-switch (v2.21.1: dynamic telemetryMode read)", () => {
  it("flush() does NOT fetch when telemetryMode flips to 'local-only' at runtime", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetchCalls += 1;
      return new Response("");
    };
    try {
      // Flip kill-switch AFTER module load — pre-v2.21.1 logger cached at boot
      // and would still fetch. Since v2.21.1, otlpActive() reads `config` per
      // call, so the queued log must drain silently.
      (cfg as { telemetryMode: string }).telemetryMode = "local-only";
      logger.info("seed in local-only", { component: "test" });
      await logger.flush();
      assert.equal(fetchCalls, 0, "must not fetch when telemetryMode='local-only'");
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
    }
  });

  it("flush() does NOT fetch when telemetryMode flips to 'off' at runtime", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetchCalls += 1;
      return new Response("");
    };
    try {
      (cfg as { telemetryMode: string }).telemetryMode = "off";
      logger.info("seed in off", { component: "test" });
      await logger.flush();
      assert.equal(fetchCalls, 0, "must not fetch when telemetryMode='off'");
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
    }
  });

  it("log() suppresses console output when telemetryMode='off'", async () => {
    // Capture stdout/stderr by replacing console methods. Mirrors the
    // assert pattern in `metrics.test.ts` for runtime config flips.
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origLog = console.log;
    const origErr = console.error;
    let stdoutCalls = 0;
    let stderrCalls = 0;
    console.log = () => {
      stdoutCalls += 1;
    };
    console.error = () => {
      stderrCalls += 1;
    };
    try {
      (cfg as { telemetryMode: string }).telemetryMode = "off";
      logger.info("silent info", { component: "test" });
      logger.error("silent error", { component: "test" });
      assert.equal(stdoutCalls, 0, "console.log must be suppressed in off mode");
      assert.equal(stderrCalls, 0, "console.error must be suppressed in off mode");
    } finally {
      console.log = origLog;
      console.error = origErr;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
    }
  });

  it("log() emits to console when telemetryMode flips back to 'on'", async () => {
    const { config: cfg } = await import("../config.js");
    const origMode = cfg.telemetryMode;
    const origLog = console.log;
    let stdoutCalls = 0;
    console.log = () => {
      stdoutCalls += 1;
    };
    try {
      (cfg as { telemetryMode: string }).telemetryMode = "on";
      logger.info("audible", { component: "test" });
      assert.ok(stdoutCalls >= 1, "console.log must be active in on mode");
    } finally {
      console.log = origLog;
      (cfg as { telemetryMode: string }).telemetryMode = origMode;
    }
  });
});
