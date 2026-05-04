import type { MiddlewareHandler } from "hono";
import { logger } from "../logger.js";
import { HTTP_DURATION, HTTP_REQUESTS, incr, observe } from "../telemetry/metrics.js";
import { statusClass, templatePath } from "../telemetry/route-template.js";
import { formatTraceparent, parseTraceparent, SpanKind, withSpan } from "../telemetry/tracer.js";
import { classifyClient } from "./classify-client.js";

export const accessLog: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  const rawPath = c.req.path;
  const route = templatePath(rawPath);
  // W3C traceparent propagation: incoming header continues an upstream trace;
  // absent header → root span with fresh traceId. The header is whitelisted
  // in cors.allowHeaders for /mcp; for other routes it's accepted but never
  // rejected — we only read it.
  const parent = parseTraceparent(c.req.header("traceparent"));
  const client = classifyClient(c.req.header("user-agent") ?? "");

  const start = Date.now();
  await withSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      parent,
      attributes: {
        component: "http",
        "http.method": method,
        "http.route": route,
        "mcp.client_class": client,
      },
    },
    async (span) => {
      // Stamp the response so downstream proxies / clients that follow W3C
      // can chain another hop. Uses the active span's context (NOT the parent)
      // so the value is the trace-id this server is contributing to.
      c.res.headers.set("traceparent", formatTraceparent(span.context));
      await next();
      const duration = Date.now() - start;
      const status = c.res.status;
      const cls = statusClass(status);

      span.setAttributes({
        "http.status_code": status,
        "http.status_class": cls,
      });

      // Always record metrics — gating happens at OTLP-flush layer.
      // /health and /icon.svg still skip the noisy access log but feed counters,
      // which lets `/api/observability` show that the process is actually serving.
      incr(HTTP_REQUESTS, { route, method, status_class: cls, client });
      observe(HTTP_DURATION, duration, { route, method, status_class: cls });

      if (rawPath === "/health" || rawPath === "/icon.svg") return;

      // The HTTP layer can only classify by user-agent — `client` (raw OAuth
      // client_name) is only known after MCP token validation, so this layer
      // uses the bounded-enum `clientClass` to avoid a same-key collision.
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      logger[level](`${method} ${rawPath} ${status} ${duration}ms [${client}]`, {
        component: "http",
        event: "http.request",
        method,
        path: rawPath,
        route,
        status: String(status),
        durationMs: duration,
        clientClass: client,
      });
    },
  );
};
