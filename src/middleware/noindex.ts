import type { MiddlewareHandler } from "hono";

/**
 * Backend host (`mcp.<domain>`) serves only functional pages: the OAuth flow,
 * QR login, per-user self-service (`/my/*`), account management, and the MCP
 * transport itself. None of it should ever appear in a search index — OAuth
 * pages are meaningless without live query params, and `/my/*` carries
 * per-user data. The marketing site (`web/`, apex host) is the only surface
 * meant to be crawled.
 *
 * `X-Robots-Tag` is set as an HTTP header (not just a `<meta>` tag) so it
 * applies to every response on this host — redirects, JSON, and non-HTML
 * bodies included — which a `<meta>` tag cannot cover. `<meta name="robots">`
 * in the page Layout stays as defense-in-depth for the HTML responses.
 */
export const noindex: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Robots-Tag", "noindex, nofollow");
};
