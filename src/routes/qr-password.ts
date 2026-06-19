import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { submitPassword } from "../qr-password-channel.js";

/**
 * Back-channel endpoint for the 2FA cloud password.
 *
 * Shared by all three QR flows (login, OAuth authorize, add-account): each emits
 * a `password_needed` SSE event with an unguessable `loginId`, then the browser
 * POSTs `{ loginId, password }` here. We hand the password to the waiting login
 * (qr-password-channel.ts) and answer 204. The `loginId` is the only correlation
 * — a caller who doesn't hold it cannot answer a prompt.
 *
 * The password is NEVER logged: only the loginId and the outcome are recorded.
 */
export function createQrPasswordRoutes(): Hono {
  const app = new Hono();

  // 2FA passwords are short; cap the body hard on this unauthenticated endpoint.
  app.use("/*", bodyLimit({ maxSize: 4096 }));

  app.post("/password", async (c) => {
    // CSRF: fail-closed. A genuine same-origin browser fetch always carries
    // either an `Origin` header or `Sec-Fetch-Site: same-origin`; a cross-site
    // form/script POST can forge neither (Origin is set by the browser, not JS;
    // Sec-Fetch-* are forbidden header names). We accept the request only if at
    // least one of those positively proves same-origin, and reject when both are
    // absent — closing the old `if (origin)` fail-open gap for header-stripping
    // clients.
    const origin = c.req.header("origin");
    const fetchSite = c.req.header("sec-fetch-site");
    let sameOrigin = false;
    if (origin) {
      try {
        sameOrigin = new URL(origin).origin === new URL(config.issuer).origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) return c.text("forbidden", 403);
    } else if (fetchSite === "same-origin" || fetchSite === "none") {
      // No Origin (some same-origin GET-turned-POST cases) but the browser
      // vouches the request did not come from another site. `none` = a
      // user-initiated load (e.g. typed/bookmarked) — not a cross-site forgery.
      sameOrigin = true;
    }
    if (!sameOrigin) return c.text("forbidden", 403);

    const body = (await c.req.json().catch(() => null)) as { loginId?: unknown; password?: unknown } | null;

    if (!body || typeof body.loginId !== "string" || typeof body.password !== "string") {
      return c.text("loginId and password required", 400);
    }
    if (body.password.length === 0) {
      return c.text("password is empty", 400);
    }

    const delivered = submitPassword(body.loginId, body.password);
    logger.info(`2FA password submission ${delivered ? "accepted" : "no matching login"}`, {
      component: "oauth-qr",
      event: delivered ? "qr.password.delivered" : "qr.password.miss",
    });

    // No pending login for this id — unknown / expired / already answered.
    if (!delivered) return c.text("no pending login", 404);
    return c.body(null, 204);
  });

  return app;
}
