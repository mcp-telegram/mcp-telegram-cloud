import { Hono } from "hono";
import { buildTgUserCookie, REVIEW_HINT_MAX_AGE_SECONDS } from "../cookie-handler.js";
import { logger, logUser } from "../logger.js";
import { reviewRateLimit } from "../rate-limit.js";
import type { SessionManager } from "../session-manager.js";

export interface ReviewRoutesDeps {
  sessions: SessionManager;
}

/**
 * Review access without a QR code.
 *
 * Directory reviewers cannot complete our normal sign-in: it is Telegram's own
 * device-link QR, which needs a phone running Telegram, and the submission form
 * forbids requiring one. This route hands them the one thing they are missing —
 * a session — by writing the same `tg_user` hint cookie the QR page writes.
 * From there the untouched OAuth fast path in `routes/oauth.tsx` recognises the
 * hint and redirects straight back with an authorization code.
 *
 * Deliberately no new authentication path: the token only selects an existing
 * session, and every check the normal flow performs still runs afterwards.
 */
export function createReviewRoutes({ sessions }: ReviewRoutesDeps): Hono {
  const app = new Hono();

  // Rate-limit before any logic: brute-force a 192-bit token is implausible,
  // but limiting makes log-flood attacks impractical and sets a principle.
  app.use("/*", reviewRateLimit);

  app.get("/", async (c) => {
    const token = c.req.query("token") ?? "";
    const resolved = token ? sessions.resolveReviewToken(token) : null;

    if (!resolved) {
      // Same response for missing, unknown, revoked and expired: a token probe
      // must not learn which of those it hit.
      // No client IP here on purpose: it is personal data, this endpoint is
      // public, and the rate limiter already contains abuse. The counter in the
      // limiter is what tells us about a flood.
      logger.warn("Review link rejected", { component: "review", event: "review.link.rejected" });
      return c.html(page("This link is not valid", "The link is unknown, expired or has been revoked."), 404);
    }

    // Reconnect before promising anything. If the demo account was logged out
    // on Telegram's side, failing here with a clear message is far better than
    // sending the reviewer into an OAuth flow that dead-ends at a QR page.
    const telegram = await sessions.tryReconnectSession(resolved.userId);
    if (!telegram) {
      logger.error("Review link resolved but its session is not connected", {
        component: "review",
        event: "review.session.unavailable",
        userId: logUser(resolved.userId),
      });
      return c.html(
        page(
          "The demo account is temporarily offline",
          "The link is valid, but its Telegram session needs to be restored. Please contact us and we will restore it.",
        ),
        503,
      );
    }

    logger.info("Review link used", {
      component: "review",
      event: "review.link.used",
      userId: logUser(resolved.userId),
      uses: resolved.uses,
    });

    c.header("Set-Cookie", buildTgUserCookie(resolved.userId, REVIEW_HINT_MAX_AGE_SECONDS));
    // Never let a shared cache keep a response that carries a session hint.
    c.header("Cache-Control", "no-store");
    return c.html(
      page(
        "Demo access is ready",
        "You can now add the connector in ChatGPT or Claude. When the client sends you here to authorize, the sign-in completes on its own — no QR code, no phone. Use the same browser for both steps: access is granted to this browser, so a private window or a different browser will show the QR code instead. If that happens, open this link there and retry.",
      ),
    );
  });

  return app;
}

/** Minimal standalone page: this is read by reviewers, not by our users, so it
 *  deliberately carries no navigation, no analytics and no locale machinery. */
function page(title: string, body: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch] as string);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — MCP Telegram</title>
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 34rem; margin: 12vh auto; padding: 0 1.5rem; color: #16202a; }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  p { margin: 0; color: #44525f; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p>${esc(body)}</p>
</body>
</html>`;
}
