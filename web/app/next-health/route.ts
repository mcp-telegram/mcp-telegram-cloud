/** Healthcheck endpoint for the Next.js content container.
 *
 * Path is intentionally not under `/api/*` because Traefik routes
 * `/api/*` to the Hono backend; `/next-health` falls through to this
 * container as part of the default catchall. Returns plain JSON so
 * Docker / Traefik / curl can probe liveness without rendering pages.
 *
 * NB: The folder name MUST NOT start with an underscore. Next.js treats
 * `_*` as private folders and excludes them from routing — that gives
 * a 404 instead of a 200 healthcheck. */
export function GET(): Response {
  return Response.json({ status: "ok", service: "mcp-telegram-web" });
}
