import type { Context, MiddlewareHandler } from "hono";
import { config } from "./config.js";
import { logger } from "./logger.js";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function getClientIp(c: Context): string {
  // Prefer X-Real-IP: Traefik sets it to the actual remote address and does
  // not forward attacker-supplied values. X-Forwarded-For is appended-to,
  // so its *first* entry is attacker-controlled if a client sends a spoofed
  // header. Fall back to the LAST XFF entry (most recent trusted hop).
  const xri = c.req.header("x-real-ip");
  if (xri) return xri.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    return parts[parts.length - 1]?.trim() || "unknown";
  }
  return "unknown";
}

function sweep(now: number): void {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

setInterval(() => sweep(Date.now()), 60_000).unref?.();

export interface RateLimitOptions {
  /** Requests per window per IP. 0 disables the limiter. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Label used in log events and bucket keys. */
  scope: string;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, scope } = opts;
  return async (c, next) => {
    if (limit <= 0 || windowMs <= 0) return next();

    const ip = getClientIp(c);
    const now = Date.now();
    const key = `${scope}:${ip}`;
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    existing.count += 1;
    if (existing.count > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      logger.warn(`rate-limit exceeded for ${scope}`, {
        component: "rate-limit",
        event: "rate_limit.exceeded",
        scope,
        path: c.req.path,
        count: existing.count,
        limit,
      });
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: "rate_limit_exceeded", retryAfter: retryAfterSec }, 429);
    }

    return next();
  };
}

export const oauthRateLimit = rateLimit({
  limit: config.oauthRateLimit,
  windowMs: config.oauthRateWindowMs,
  scope: "oauth",
});
