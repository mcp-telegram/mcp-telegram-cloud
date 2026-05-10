/** Next.js 16 renamed `middleware.ts` → `proxy.ts`. Runtime is Node.js, no edge.
 *
 * Delegates to next-intl's locale detection middleware which:
 *   1. Reads Accept-Language for first-visit redirect.
 *   2. Sets cookie `NEXT_LOCALE` so the choice sticks.
 *   3. Adds locale prefix per `localePrefix: 'as-needed'` (default = no prefix).
 *
 * The matcher excludes API/internal/static paths so MCP backend routes that
 * Traefik sends to this container in development never accidentally hit
 * locale rewriting. In production the backend gets its own container, so this
 * is just defensive. */

import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Exclude:
  // - api/trpc/_next/_vercel internals
  // - any path containing a dot (favicon.ico, sitemap.xml, robots.txt, …)
  // - `next-health` healthcheck route (consumed by Docker/Swarm, must stay locale-free)
  matcher: "/((?!api|trpc|_next|_vercel|next-health|.*\\..*).*)",
};
