import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isAdminSessionValid } from "../auth/admin.js";
import { config } from "../config.js";
import type { DestructiveGuard } from "../destructive-guard.js";
import { logger, logUser } from "../logger.js";
import type { OAuthProvider } from "../oauth.js";
import { AuditPage } from "../pages/AuditPage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { UploadsPage, type UploadsPageProps } from "../pages/UploadsPage.js";
import { makeUploadRateLimit } from "../rate-limit.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";
import type { UploadStore } from "../upload-store.js";
import { MCP_RESOURCE_METADATA_PATH, rootUrl } from "./oauth.js";

export interface MyRoutesDeps {
  destructive: DestructiveGuard;
  sessions: SessionManager;
  uploads: UploadStore;
  /** Token validator for the Bearer path on `POST /my/upload` (MCP agents). */
  oauth: Pick<OAuthProvider, "validateToken">;
}

/**
 * Routes under `/my/*` are user-facing, authenticated one of two ways
 * depending on `config.singleOperatorMode`:
 *
 * - Single-operator mode: the admin session cookie (see auth/admin.ts), same
 *   gate as /oauth/authorize. There is exactly one owner, so a valid admin
 *   session always maps to the fixed `config.ownerUserId`.
 * - Multi-tenant (default): upstream's original mechanism — the `tg_user`
 *   cookie (the Telegram username reported back from QR login), cross-checked
 *   against saved session ids so a stale/foreign cookie value can't
 *   impersonate a real user.
 */

function getUsernameFromCookie(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)tg_user=([^;]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function requireUser(c: Context, sessions: SessionManager): string | null {
  if (config.singleOperatorMode) {
    if (!isAdminSessionValid(c.req.header("cookie"))) return null;
    return config.ownerUserId;
  }
  const username = getUsernameFromCookie(c);
  if (!username) return null;
  const saved = sessions.getSavedUserIds();
  if (!saved.includes(username)) return null;
  return username;
}

/** Who is uploading, and by which credential — the two paths differ in CSRF
 * exposure, so the branch has to stay visible at the call site. */
type UploadCaller = { userId: string; via: "bearer" | "cookie" };

/**
 * Resolve the uploader for `POST /my/upload`.
 *
 * Bearer wins over cookie when both are present: a token is a deliberate
 * statement of intent by a client, a cookie is ambient browser authority.
 * An invalid Bearer is a hard stop and never falls through to the cookie —
 * otherwise an agent holding a stale token would silently start writing as
 * whoever happens to be logged in to the same browser profile.
 */
function resolveUploader(c: Context, deps: MyRoutesDeps): UploadCaller | null {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const tokenInfo = deps.oauth.validateToken(auth.slice(7));
    return tokenInfo ? { userId: tokenInfo.userId, via: "bearer" } : null;
  }
  const userId = requireUser(c, deps.sessions);
  return userId ? { userId, via: "cookie" } : null;
}

function unauthorizedRedirect(c: Context): Response {
  return c.redirect(config.singleOperatorMode ? "/admin-login" : `${config.issuer}/login`, 302);
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

export function createMyRoutes(deps: MyRoutesDeps): Hono {
  const { destructive, sessions, uploads } = deps;
  const app = new Hono({ strict: false });
  const uploadRateLimit = makeUploadRateLimit();

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
    // Rate limit runs BEFORE bodyLimit so a flood is rejected without reading
    // (and buffering) each body first.
    uploadRateLimit,
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
      const caller = resolveUploader(c, deps);
      if (!caller) {
        // Point token-bearing clients at the discovery document, same as /mcp,
        // so a 401 is actionable instead of a dead end.
        return c.json({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${rootUrl(config.issuer, MCP_RESOURCE_METADATA_PATH)}"`,
        });
      }
      const userId = caller.userId;

      // CSRF: same-origin only, identical to /settings POST — but ONLY for the
      // cookie path. CSRF exists because a browser attaches cookies to a
      // cross-site request automatically; a Bearer token is never attached
      // automatically. Moreover, an `Authorization` header makes the request
      // non-simple, so a hostile page can't even reach this branch without a
      // CORS preflight that we never answer (no CORS middleware on /my/*).
      // Do not "restore symmetry" by applying the check to Bearer: that is
      // what made the route unusable for agents in the first place, since an
      // MCP client has neither Origin nor Referer.
      if (caller.via === "cookie") {
        const headerValue = c.req.header("origin") ?? c.req.header("referer");
        if (!headerValue || !originMatchesIssuer(headerValue)) {
          return c.json({ error: "forbidden" }, 403);
        }
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
          source: caller.via,
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
        source: caller.via,
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
