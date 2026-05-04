import type { MiddlewareHandler } from "hono";
import { logger } from "../logger.js";
import { HTTP_DURATION, HTTP_REQUESTS, incr, observe } from "../telemetry/metrics.js";
import { statusClass, templatePath } from "../telemetry/route-template.js";

function classifyClient(ua: string): string {
  const l = ua.toLowerCase();
  if (l.includes("chatgpt") || l.includes("openai")) return "chatgpt";
  if (l.includes("claude") || l.includes("anthropic")) return "claude";
  if (l.includes("bot") || l.includes("spider") || l.includes("crawler") || l.includes("scan")) return "bot";
  if (l.includes("mozilla") || l.includes("chrome") || l.includes("safari") || l.includes("firefox")) return "browser";
  if (l.includes("node") || l.includes("python") || l.includes("curl") || l.includes("fetch")) return "script";
  if (!l) return "empty";
  return "other";
}

export const accessLog: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  const method = c.req.method;
  // Hono's c.req.path is path-only (no query string) — verified empirically;
  // logging it satisfies the "no query string" invariant in LogFields.
  const rawPath = c.req.path;
  const route = templatePath(rawPath);
  const cls = statusClass(status);
  const client = classifyClient(c.req.header("user-agent") ?? "");

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
};
