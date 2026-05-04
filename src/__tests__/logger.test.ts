import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
// logger.ts caches OTLP_ENDPOINT and OTLP_ACTIVE at module load — set both before
// importing so flush() actually attempts the fetch we want to inspect.
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
    globalThis.fetch = async (_url, init) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await logger.flush();
      assert.equal(captured.headers["Content-Type"], "application/json");
      assert.equal(captured.headers.Authorization, undefined, "no Authorization when auth empty");
    } finally {
      globalThis.fetch = origFetch;
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
    globalThis.fetch = async (_url, init) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await logger.flush();
      const expected = `Basic ${Buffer.from("ingest-user:s3cret-pw").toString("base64")}`;
      assert.equal(captured.headers.Authorization, expected);
    } finally {
      globalThis.fetch = origFetch;
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
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
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
      globalThis.fetch = origFetch;
      _resetMetricsForTest();
    }
  });

  it("flush() increments counter with signal=logs reason=network when fetch throws", async () => {
    const { snapshot, _resetMetricsForTest } = await import("../telemetry/metrics.js");
    _resetMetricsForTest();
    logger.info("seed", { component: "test" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
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
      globalThis.fetch = origFetch;
      _resetMetricsForTest();
    }
  });

  it("flush() attaches traceId/spanId from active span to LogRecord (Phase C correlation)", async () => {
    const { withSpan, _resetTracerForTest } = await import("../telemetry/tracer.js");
    _resetTracerForTest();
    const captured: { records: Array<{ traceId?: string; spanId?: string }> } = { records: [] };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
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
      globalThis.fetch = origFetch;
      _resetTracerForTest();
    }
  });
});
