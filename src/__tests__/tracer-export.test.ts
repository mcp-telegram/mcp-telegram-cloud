import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
// Both flags must be set BEFORE tracer.ts imports `config` so the
// `otlpActive()` gate evaluates to true at flush time.
process.env.MCP_TELEGRAM_TELEMETRY = "on";
process.env.SIGNOZ_ENDPOINT = "https://signoz.test";

const { withSpan, flushTraces, _resetTracerForTest, SpanKind } = await import("../telemetry/tracer.js");

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: ReturnType<typeof JSON.parse>;
}

function mockFetch(handler: () => Response | Promise<Response>): {
  captures: CapturedRequest[];
  restore: () => void;
} {
  const captures: CapturedRequest[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (url: string | URL | Request, init: RequestInit | undefined) => {
    captures.push({
      url: String(url),
      headers: ((init as RequestInit).headers ?? {}) as Record<string, string>,
      body: JSON.parse((init as RequestInit).body as string),
    });
    return handler();
  };
  return { captures, restore: () => (globalThis.fetch = orig) };
}

describe("tracer — OTLP export success path", () => {
  afterEach(() => _resetTracerForTest());

  it("posts a well-formed OTLP payload to /v1/traces on flush", async () => {
    const { captures, restore } = mockFetch(() => new Response(""));
    try {
      await withSpan(
        "GET /mcp",
        { kind: SpanKind.SERVER, attributes: { "http.method": "GET", "http.route": "/mcp" } },
        async (span) => {
          span.setAttribute("http.status_code", 200);
        },
      );
      await flushTraces();
      assert.equal(captures.length, 1, "exactly one fetch issued");
      assert.equal(captures[0].url, "https://signoz.test/v1/traces");
      assert.equal(captures[0].headers["Content-Type"], "application/json");

      const payload = captures[0].body;
      assert.ok(payload.resourceSpans);
      const scopeSpans = payload.resourceSpans[0].scopeSpans[0];
      assert.equal(scopeSpans.spans.length, 1);
      const exported = scopeSpans.spans[0];
      assert.equal(exported.name, "GET /mcp");
      assert.equal(exported.kind, 2, "SpanKind.SERVER");
      assert.match(exported.traceId, /^[0-9a-f]{32}$/);
      assert.match(exported.spanId, /^[0-9a-f]{16}$/);
      // Attribute encoding: integer-valued numbers go to intValue; strings to stringValue.
      const attrMap = Object.fromEntries(
        exported.attributes.map((a: { key: string; value: object }) => [a.key, a.value]),
      );
      assert.deepEqual(attrMap["http.method"], { stringValue: "GET" });
      assert.deepEqual(attrMap["http.route"], { stringValue: "/mcp" });
      assert.deepEqual(attrMap["http.status_code"], { intValue: "200" });
    } finally {
      restore();
    }
  });

  it("emits Authorization header when SIGNOZ_AUTH is set (mirrors metrics/logger behavior)", async () => {
    const { config: cfg } = await import("../config.js");
    const orig = cfg.signozAuth;
    (cfg as { signozAuth: string }).signozAuth = "ingest-user:s3cret-pw";
    const { captures, restore } = mockFetch(() => new Response(""));
    try {
      await withSpan("auth-test", {}, async () => {});
      await flushTraces();
      assert.equal(captures.length, 1);
      const expected = `Basic ${Buffer.from("ingest-user:s3cret-pw").toString("base64")}`;
      assert.equal(captures[0].headers.Authorization, expected);
    } finally {
      restore();
      (cfg as { signozAuth: string }).signozAuth = orig;
    }
  });

  it("increments TELEMETRY_EXPORT_ERRORS counter on 4xx response (signal=traces, reason=auth_failed)", async () => {
    const { snapshot, _resetMetricsForTest } = await import("../telemetry/metrics.js");
    _resetMetricsForTest();
    const { restore } = mockFetch(() => new Response("Unauthorized", { status: 401 }));
    try {
      await withSpan("trace-401", {}, async () => {});
      await flushTraces();
      const errs = snapshot().counters.find((c) => c.name === "telemetry.export.errors");
      assert.ok(errs, "counter declared");
      const auth = errs.points.find((p) => p.labels.signal === "traces" && p.labels.reason === "auth_failed");
      assert.ok(auth, "auth_failed point exists for signal=traces");
      assert.equal(auth.value, 1);
    } finally {
      restore();
      _resetMetricsForTest();
    }
  });

  it("increments TELEMETRY_EXPORT_ERRORS with reason=network on AbortError (timeout)", async () => {
    const { snapshot, _resetMetricsForTest } = await import("../telemetry/metrics.js");
    _resetMetricsForTest();
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => {
      const e = new Error("timed out");
      e.name = "AbortError";
      throw e;
    };
    try {
      await withSpan("trace-timeout", {}, async () => {});
      await flushTraces();
      const errs = snapshot().counters.find((c) => c.name === "telemetry.export.errors");
      const net = errs?.points.find((p) => p.labels.signal === "traces" && p.labels.reason === "network");
      assert.ok(net, "network point exists for signal=traces");
      assert.equal(net.value, 1);
    } finally {
      globalThis.fetch = orig;
      _resetMetricsForTest();
    }
  });

  it("re-arms a follow-up flush when new spans land DURING an in-flight flush", async () => {
    // Race: the first flush is awaiting fetch; while it's in-flight, a new
    // span lands in exportQueue. Without the re-arm in flushTraces' finally,
    // the size-trigger from pushFinished returns the existing in-flight
    // promise and the new span sits until next interval tick. With re-arm,
    // a 2nd fetch fires immediately after the 1st resolves.
    const { restore, captures } = mockFetch(() => new Response(""));
    try {
      // Manually queue 1 span via a finished withSpan, then issue first flushTraces.
      await withSpan("s1", {}, async () => {});
      // Suspend the flush to simulate an in-flight POST: replace fetch with a
      // promise that we can resolve after queueing s2.
      let resolveFirstFetch: (r: Response) => void = () => {};
      const orig = globalThis.fetch;
      (globalThis as { fetch: unknown }).fetch = () => {
        return new Promise<Response>((resolve) => {
          resolveFirstFetch = resolve;
        });
      };
      const flushP = flushTraces();
      // While first flush is suspended, push a 2nd span.
      await withSpan("s2", {}, async () => {});
      // Now restore the captures-tracking mock to capture the follow-up flush.
      // First, resolve the in-flight promise to trigger the .finally() re-arm.
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        const url = String(args[0]);
        const init = args[1] as RequestInit;
        captures.push({
          url,
          headers: (init.headers ?? {}) as Record<string, string>,
          body: JSON.parse(init.body as string),
        });
        return new Response("");
      }) as typeof fetch;
      resolveFirstFetch(new Response(""));
      await flushP;
      // Allow the queued microtask scheduling the re-arm to land.
      await new Promise((r) => setTimeout(r, 10));
      // Expect at least 1 capture (the 2nd flush), confirming the re-arm.
      assert.ok(captures.length >= 1, `expected re-arm flush, got ${captures.length} captures`);
      // Restore baseline fetch.
      globalThis.fetch = orig;
    } finally {
      restore();
    }
  });
});

describe("tracer — runtime SpanAttrs allow-list", () => {
  afterEach(() => _resetTracerForTest());

  it("setAttributes silently drops keys outside the runtime allow-list", async () => {
    const { recentSpans } = await import("../telemetry/tracer.js");
    await withSpan("escape-attempt", {}, async (span) => {
      // Cast escape — bypass compile-time SpanAttrs whitelist.
      // biome-ignore lint/suspicious/noExplicitAny: testing runtime gate.
      span.setAttributes({ component: "x", peer: "secret-peer", userId: "raw" } as any);
    });
    const [s] = recentSpans();
    assert.equal(s.attributes.component, "x", "allowed key kept");
    assert.equal((s.attributes as Record<string, unknown>).peer, undefined, "PII key dropped");
    assert.equal((s.attributes as Record<string, unknown>).userId, undefined, "PII key dropped");
  });

  it("setAttribute (single) also drops unknown keys", async () => {
    const { recentSpans } = await import("../telemetry/tracer.js");
    await withSpan("escape-attempt-single", {}, async (span) => {
      // Cast escape — bypass compile-time SpanAttrs<K> typing so we can prove
      // the runtime allow-list still drops the unknown key.
      (span.setAttribute as (k: string, v: string) => void)("messageText", "secret");
    });
    const [s] = recentSpans();
    assert.equal((s.attributes as Record<string, unknown>).messageText, undefined);
  });
});
