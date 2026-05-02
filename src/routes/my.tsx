import type { Context } from "hono";
import { Hono } from "hono";
import { config } from "../config.js";
import type { DestructiveGuard } from "../destructive-guard.js";
import { logger, logUser } from "../logger.js";
import { AuditPage } from "../pages/AuditPage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import type { SessionManager } from "../session-manager.js";

export interface MyRoutesDeps {
  destructive: DestructiveGuard;
  sessions: SessionManager;
}

/**
 * Routes under `/my/*` are user-facing — authenticated by the `tg_user` cookie
 * set during the OAuth/QR flow (see cookie-handler.ts). The cookie value is the
 * Telegram username, which doubles as the userId in cloud's SQLite. We require
 * a matching saved session to confirm the user actually owns that account on
 * this server (cookie alone is not sufficient — same browser switching servers
 * would otherwise inherit a stale username).
 */

function getUsernameFromCookie(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/tg_user=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function requireUser(c: Context, sessions: SessionManager): string | null {
  const username = getUsernameFromCookie(c);
  if (!username) return null;
  const saved = sessions.getSavedUserIds();
  if (!saved.includes(username)) return null;
  return username;
}

function unauthorizedRedirect(c: Context): Response {
  return c.redirect(`${config.issuer}/login`, 302);
}

/** Exact-origin match for CSRF — never use startsWith on URLs (e.g.
 * `https://issuer.com.evil.io/...` would pass a prefix check). */
function originMatchesIssuer(headerValue: string): boolean {
  try {
    return new URL(headerValue).origin === config.issuer;
  } catch {
    return false;
  }
}

export function createMyRoutes({ destructive, sessions }: MyRoutesDeps): Hono {
  const app = new Hono({ strict: false });

  app.get("/", (c) => c.redirect("/my/settings", 302));

  app.get("/settings", (c) => {
    const userId = requireUser(c, sessions);
    if (!userId) return unauthorizedRedirect(c);

    const ok = c.req.query("ok");
    const flash = ok === "on" ? "Destructive tools enabled." : ok === "off" ? "Destructive tools disabled." : undefined;

    const props: { username: string; enabled: boolean; todayCount: number; dailyLimit: number; flash?: string } = {
      username: userId,
      enabled: destructive.isEnabled(userId),
      todayCount: destructive.todayOkCount(userId),
      dailyLimit: config.destructiveDailyLimit,
    };
    if (flash !== undefined) props.flash = flash;

    return c.html(<SettingsPage {...props} />);
  });

  app.post("/settings", async (c) => {
    const userId = requireUser(c, sessions);
    if (!userId) return unauthorizedRedirect(c);

    // CSRF: same-origin only. The form is HTML-POST'ed without a token, so we
    // require the Origin (or Referer fallback) to parse to an URL whose .origin
    // exactly equals ISSUER. A startsWith check would let `https://issuer.evil`
    // pass; SameSite=Lax helps but isn't sufficient defense in depth.
    const headerValue = c.req.header("origin") ?? c.req.header("referer");
    if (!headerValue || !originMatchesIssuer(headerValue)) {
      return c.text("forbidden", 403);
    }

    const form = await c.req.formData();
    const next = form.get("enabled") === "1";
    destructive.setEnabled(userId, next);

    logger.info(`Destructive toggle: ${next ? "enabled" : "disabled"}`, {
      component: "destructive",
      userId: logUser(userId),
      event: "destructive.toggle",
      enabled: next ? 1 : 0,
    });

    // POST → 303 redirect to GET so refresh doesn't re-toggle.
    return c.redirect(`/my/settings?ok=${next ? "on" : "off"}`, 303);
  });

  app.get("/audit", (c) => {
    const userId = requireUser(c, sessions);
    if (!userId) return unauthorizedRedirect(c);

    const rows = destructive.listForUser(userId, 100);
    return c.html(<AuditPage username={userId} rows={rows} />);
  });

  return app;
}
