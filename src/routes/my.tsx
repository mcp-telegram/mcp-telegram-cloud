import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import type { DestructiveGuard } from "../destructive-guard.js";
import { logger, logUser } from "../logger.js";
import { AuditPage } from "../pages/AuditPage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { UploadsPage, type UploadsPageProps } from "../pages/UploadsPage.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";
import type { UploadStore } from "../upload-store.js";

export interface MyRoutesDeps {
  destructive: DestructiveGuard;
  sessions: SessionManager;
  uploads: UploadStore;
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
  // Anchor on start-of-string or `; ` so a cookie named `xtg_user` or one whose
  // value happens to contain the literal substring `tg_user=victim` doesn't
  // get picked up first. Defense in depth — typical browsers don't construct
  // such headers, but adjacent cookie-injection paths shouldn't compromise auth.
  const match = cookies.match(/(?:^|;\s*)tg_user=([^;]+)/);
  if (!match) return undefined;
  // decodeURIComponent throws URIError on malformed `%xx` sequences; treat that
  // as missing-cookie so the route returns its normal unauthenticated branch
  // (401/302) instead of leaking a 500.
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
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

export function createMyRoutes({ destructive, sessions, uploads }: MyRoutesDeps): Hono {
  const app = new Hono({ strict: false });

  app.get("/", (c) => c.redirect("/my/settings", 302));

  app.get("/uploads", async (c) => {
    const userId = requireUser(c, sessions);
    if (!userId) return unauthorizedRedirect(c);

    const flash = c.req.query("flash") ?? undefined;
    const rows = uploads.listForUser(userId, 50);
    const props: UploadsPageProps = {
      username: userId,
      rows,
      fileMaxBytes: config.uploadFileMaxBytes,
      quotaBytes: config.uploadQuotaBytes,
      ttlSeconds: config.uploadTtlSeconds,
      pendingBytes: uploads.pendingBytesForUser(userId),
    };
    if (flash !== undefined) props.flash = flash;

    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("uploads", {
        ...props,
        locale,
        scripts: islandScripts("language-switcher", "uploads"),
      });
      return c.html(html);
    }
    return c.html(<UploadsPage {...props} />);
  });

  // bodyLimit caps multipart parser allocation BEFORE preflight runs. Without it,
  // a logged-in user could POST a multi-GB body and exhaust container RAM before
  // UploadStore.preflight (which only sees the parsed Buffer) gets a chance to deny.
  // Slack of 1 MB covers multipart boundaries + small header overhead per part.
  const UPLOAD_BODY_SLACK_BYTES = 1024 * 1024;
  app.post(
    "/upload",
    bodyLimit({
      maxSize: config.uploadFileMaxBytes + UPLOAD_BODY_SLACK_BYTES,
      onError: (c) =>
        c.json(
          {
            error: "file_too_large",
            message: `Request body exceeds the per-file cap (${config.uploadFileMaxBytes} bytes + multipart slack).`,
          },
          413,
        ),
    }),
    async (c) => {
      const userId = requireUser(c, sessions);
      if (!userId) return c.json({ error: "unauthorized" }, 401);

      // CSRF: same-origin only, identical to /settings POST.
      const headerValue = c.req.header("origin") ?? c.req.header("referer");
      if (!headerValue || !originMatchesIssuer(headerValue)) {
        return c.json({ error: "forbidden" }, 403);
      }

      let form: FormData;
      try {
        form = await c.req.formData();
      } catch (e) {
        return c.json({ error: "bad_request", message: `Invalid multipart body: ${(e as Error).message}` }, 400);
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "bad_request", message: "Missing 'file' field" }, 400);
      }

      const buf = Buffer.from(await file.arrayBuffer());
      const denied = uploads.preflight(userId, buf.byteLength);
      if (denied) {
        logger.warn(`Upload denied: ${denied.reason}`, {
          component: "uploads",
          userId: logUser(userId),
          event: "uploads.denied",
          reason: denied.reason,
          size: buf.byteLength,
        });
        const status = denied.reason === "file_too_large" ? 413 : 429;
        return c.json({ error: denied.reason, message: denied.message }, status);
      }

      const result = await uploads.put(userId, buf, file.type || "application/octet-stream", file.name || null);
      if (!result.ok) {
        // TOCTOU between preflight and put — same envelope, log & return.
        const status = result.reason === "file_too_large" ? 413 : 429;
        return c.json({ error: result.reason, message: result.message }, status);
      }

      logger.info(`Upload stored: ${result.id}`, {
        component: "uploads",
        userId: logUser(userId),
        event: "uploads.stored",
        uploadId: result.id,
        size: buf.byteLength,
        mime: file.type,
      });

      return c.json({
        id: result.id,
        expiresAt: result.expiresAt.toISOString(),
        size: buf.byteLength,
        mime: file.type || "application/octet-stream",
      });
    },
  );

  app.get("/settings", async (c) => {
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

    // Prefer the React/i18n page when its bundle is built; fall back to the
    // legacy hono page otherwise (e.g. dev without `bun app:build`). The
    // switch is per-request and transparent.
    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("settings", { ...props, locale, scripts: islandScripts("language-switcher") });
      return c.html(html);
    }
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

  app.get("/audit", async (c) => {
    const userId = requireUser(c, sessions);
    if (!userId) return unauthorizedRedirect(c);

    const rows = destructive.listForUser(userId, 100);

    // Prefer the React/i18n page when its bundle is built; fall back to the
    // legacy hono page otherwise (mirrors /settings).
    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("audit", {
        username: userId,
        rows,
        locale,
        scripts: islandScripts("language-switcher"),
      });
      return c.html(html);
    }
    return c.html(<AuditPage username={userId} rows={rows} />);
  });

  return app;
}
