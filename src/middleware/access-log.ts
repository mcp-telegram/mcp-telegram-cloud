import type { MiddlewareHandler } from "hono";
import { logger } from "../logger.js";

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
  const path = c.req.path;

  if (path === "/health" || path === "/icon.svg") return;

  const client = classifyClient(c.req.header("user-agent") ?? "");
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  logger[level](`${method} ${path} ${status} ${duration}ms [${client}]`, {
    component: "http",
    event: "http.request",
    method,
    path,
    status: String(status),
    durationMs: duration,
    client,
  });
};
