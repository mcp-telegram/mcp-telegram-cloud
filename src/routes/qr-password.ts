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
    // CSRF defense-in-depth: same-origin only when an Origin header is present.
    const origin = c.req.header("origin");
    if (origin) {
      try {
        if (new URL(origin).origin !== new URL(config.issuer).origin) {
          return c.text("forbidden", 403);
        }
      } catch {
        return c.text("forbidden", 403);
      }
    }

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
