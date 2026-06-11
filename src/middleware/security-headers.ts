import type { MiddlewareHandler } from "hono";

/**
 * Security response headers for the backend host (`mcp.<domain>`), which serves
 * HTML for the OAuth flow, QR login, and `/my/*` self-service — a clickjacking
 * + XSS surface that renders client-supplied values (client_name, redirect_uri,
 * state). Added after the 2026-06-11 security audit (finding H1).
 *
 * CSP is tuned to the actual page composition:
 *   - script-src 'self'         — islands are external ES modules under
 *                                 /app-assets/ (Layout.tsx `<script type=module src>`).
 *                                 NO inline scripts → no 'unsafe-inline', no nonce needed.
 *   - style-src 'self' 'unsafe-inline' — pages use an inline <style> block
 *                                 (hono/css → Layout) and React inline style={{}}.
 *                                 'unsafe-inline' for styles only is low-risk.
 *   - img-src 'self' data:      — the QR island injects <img src="data:image/png;...">.
 *   - connect-src 'self'        — QR login uses a same-origin SSE stream.
 *   - frame-ancestors 'none'    — defeats clickjacking of the OAuth approve flow
 *                                 (stronger than X-Frame-Options; both set for
 *                                 older-UA coverage).
 *   - base-uri 'none', object-src 'none', form-action 'self' — lock down the rest.
 *
 * HSTS is set unconditionally: the backend is HTTPS-only behind Traefik+LE, so
 * pinning a year of HTTPS closes the first-request downgrade window. No `preload`
 * yet (opt-in is hard to reverse); add once confident across all subdomains.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("Content-Security-Policy", CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
};
