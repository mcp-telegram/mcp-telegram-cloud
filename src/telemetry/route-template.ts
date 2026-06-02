/**
 * Map raw request paths to a small set of stable route templates.
 *
 * Why: histogram/counter cardinality is bounded by label combinations.
 * Raw paths like `/oauth/authorize?state=abc...` or `/my/uploads/<uuid>`
 * would explode the time-series count and OOM SigNoz storage. Templates
 * collapse dynamic segments (UUIDs, hex tokens) to a fixed name.
 *
 * Returns the literal `path` if no template matches — better to over-emit
 * a known route than emit `unknown` and lose the signal entirely.
 */

/** Match a long opaque ID-shaped segment: hex, UUID-with-dashes, or ULID/base32.
 * Length ≥12 + must contain at least one digit anywhere — keeps routes
 * like "settings" or "audit-log" out of the collapse. */
const ID_SHAPED = /^(?=[a-z0-9-]{12,}$)(?=.*[0-9])[a-z0-9-]+$/i;

const STATIC = new Set([
  "/health",
  "/icon.svg",
  "/icon.png",
  "/icon-256.png",
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
  "/llms.txt",
  "/security.txt",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/oauth/authorize",
  "/oauth/authorize/qr",
  "/oauth/authorize/qr/cookie",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/register",
  "/login",
  "/login/qr",
  "/mcp",
  "/api/stats",
  "/api/observability",
  "/my",
  "/my/settings",
  "/my/audit",
  "/my/uploads",
  "/my/upload",
  "/privacy",
  "/terms",
  "/about",
  "/",
]);

export function templatePath(path: string): string {
  if (STATIC.has(path)) return path;
  if (path.startsWith("/my/upload/")) return "/my/upload/:id";
  if (path.startsWith("/my/uploads/")) return "/my/uploads/:id";
  // Content-hashed React island bundles — collapse so each hash isn't its own
  // time series.
  if (path.startsWith("/app-assets/")) return "/app-assets/:asset";
  // Collapse any ID-shaped segment anywhere in the path. Bounds the time-series
  // cardinality even for future routes shaped `/users/:id/profile` that we
  // forgot to template explicitly. Cost: a brand-new route segment that happens
  // to look ID-shaped (long, contains a digit) gets masked — acceptable trade
  // versus an unbounded series.
  const segments = path.split("/");
  let changed = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && ID_SHAPED.test(seg)) {
      segments[i] = ":id";
      changed = true;
    }
  }
  return changed ? segments.join("/") : path;
}

/** HTTP status → status_class label (`2xx`, `3xx`, `4xx`, `5xx`). */
export function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}
