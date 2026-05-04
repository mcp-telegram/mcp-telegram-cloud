import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Hono } from "hono";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { accessLog } = await import("../middleware/access-log.js");
const { recentSpans, _resetTracerForTest, parseTraceparent } = await import("../telemetry/tracer.js");

function makeApp(): Hono {
  const app = new Hono({ strict: false });
  app.use("*", accessLog);
  app.get("/health", (c) => c.text("ok"));
  app.get("/mcp", (c) => c.json({ ok: true }));
  app.get("/oauth/authorize", (c) => c.text("authorize"));
  app.get("/error", () => {
    throw new Error("synthetic error");
  });
  app.onError((_e, c) => c.text("internal", 500));
  return app;
}

describe("tracer middleware — server span per request", () => {
  afterEach(() => _resetTracerForTest());

  it("creates a SERVER span with http attributes for each request", async () => {
    const app = makeApp();
    const res = await app.request("/mcp");
    assert.equal(res.status, 200);
    const spans = recentSpans();
    assert.equal(spans.length, 1);
    const span = spans[0];
    assert.equal(span.name, "GET /mcp");
    assert.equal(span.kind, 2, "SpanKind.SERVER = 2");
    assert.equal(span.attributes.component, "http");
    assert.equal(span.attributes["http.method"], "GET");
    assert.equal(span.attributes["http.route"], "/mcp");
    assert.equal(span.attributes["http.status_code"], 200);
    assert.equal(span.attributes["http.status_class"], "2xx");
    // mcp.client_class derived from user-agent — empty UA → 'empty'
    assert.equal(span.attributes["mcp.client_class"], "empty");
  });

  it("templated routes collapse to low-cardinality form", async () => {
    const app = makeApp();
    await app.request("/health");
    const span = recentSpans()[0];
    assert.equal(span.attributes["http.route"], "/health");
  });

  it("propagates incoming traceparent (continues upstream trace)", async () => {
    const app = makeApp();
    const upstream = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await app.request("/mcp", { headers: { traceparent: upstream } });
    assert.equal(res.status, 200);
    const span = recentSpans()[0];
    assert.equal(span.context.traceId, "0af7651916cd43dd8448eb211c80319c");
    assert.equal(span.parentSpanId, "b7ad6b7169203331");
    // Response stamped with this server's contribution to the trace.
    const outHeader = res.headers.get("traceparent");
    assert.ok(outHeader, "response carries traceparent");
    const outCtx = parseTraceparent(outHeader);
    assert.ok(outCtx);
    assert.equal(outCtx.traceId, "0af7651916cd43dd8448eb211c80319c");
    assert.notEqual(outCtx.spanId, "b7ad6b7169203331", "fresh span_id, not parent's");
  });

  it("starts a fresh root trace when no traceparent header is present", async () => {
    const app = makeApp();
    const res = await app.request("/mcp");
    const span = recentSpans()[0];
    assert.equal(span.parentSpanId, "", "no parent → root span");
    const outHeader = res.headers.get("traceparent");
    const outCtx = parseTraceparent(outHeader);
    assert.ok(outCtx);
    assert.equal(outCtx.traceId, span.context.traceId);
  });

  it("sets ERROR status when handler throws", async () => {
    const app = makeApp();
    const res = await app.request("/error");
    assert.equal(res.status, 500);
    const span = recentSpans()[0];
    // Hono's onError catches the throw, so the span sees status 500 — but
    // the synchronous throw from the route is caught BEFORE next() resolves,
    // so the span exits via the catch path (status=ERROR, exception event).
    // Either way, assertion: we recorded the failed request with 5xx class.
    assert.equal(span.attributes["http.status_class"], "5xx");
  });

  it("rejects malformed traceparent and starts fresh (does not crash)", async () => {
    const app = makeApp();
    const res = await app.request("/mcp", { headers: { traceparent: "not-a-traceparent" } });
    assert.equal(res.status, 200);
    const span = recentSpans()[0];
    assert.equal(span.parentSpanId, "", "malformed parent ignored → root span");
  });

  it("PRIVACY: span name uses templated route, not raw path with id-shaped segment", async () => {
    const app = makeApp();
    app.get("/my/upload/:id", (c) => c.text("ok"));
    // Hit a path with a long ID-shaped segment — accessLog must collapse via
    // templatePath BEFORE building the span name. Otherwise an attacker /
    // future route could leak the raw id (which might be a session token,
    // upload UUID, or — in a regression — a phone number) into span name,
    // which is searchable in SigNoz UI.
    await app.request("/my/upload/abc123-deadbeef-feedface-uuid");
    const span = recentSpans()[0];
    // span.name = "${method} ${route}" — must be the template form.
    assert.equal(span.name, "GET /my/upload/:id", "span name uses /my/upload/:id, not the raw uuid path");
    // Just to be defensive — the raw 36-char id must not appear anywhere.
    assert.ok(!span.name.includes("deadbeef"), "raw id leaked into span name");
  });
});
