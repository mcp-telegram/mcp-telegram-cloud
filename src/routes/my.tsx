import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import { readBrowserSessionToken } from "../cookie-handler.js";
import type { DestructiveGuard } from "../destructive-guard.js";
import { DOWNLOAD_CHUNK_BYTES, type DownloadStore } from "../download-store.js";
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
  downloads?: DownloadStore;
  /** Token validator for the Bearer path on `POST /my/upload` (MCP agents). */
  oauth: Pick<OAuthProvider, "validateToken" | "getBrowserSessionUser">;
}

/**
 * Routes under `/my/*` are user-facing, authenticated by the browser session
 * cookie `tg_sid` (see cookie-handler.ts). The session is created only after
 * the server saw proof of identity (a finished QR login or a review token), so
 * the cookie cannot be forged from a username the way the old `tg_user` value
 * could. We still require a saved Telegram session for that user, so a browser
 * that outlived the user's account on this server is treated as signed out.
 */
function requireUser(c: Context, deps: Pick<MyRoutesDeps, "oauth" | "sessions">): string | null {
  const userId = deps.oauth.getBrowserSessionUser(readBrowserSessionToken(c.req.header("cookie")));
  if (!userId) return null;
  if (!deps.sessions.getSavedUserIds().includes(userId)) return null;
  return userId;
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
  const userId = requireUser(c, deps);
  return userId ? { userId, via: "cookie" } : null;
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

export function createMyRoutes(deps: MyRoutesDeps): Hono {
  const { destructive, uploads } = deps;
  const app = new Hono({ strict: false });
  const uploadRateLimit = makeUploadRateLimit();

  app.get("/", (c) => c.redirect("/my/settings", 302));

  // IDs are selectors, not credentials. No bearer tokens or signed sharing
  // secrets in query strings, paths, Referer, access logs or browser history.
  app.use("/download/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Vary", "Authorization, Cookie");
    await next();
  });
  app.get("/download/:id", uploadRateLimit, (c) => {
    const auth = c.req.header("authorization");
    // Invalid/malformed Authorization must not fall through to browser identity.
    const userId =
      auth !== undefined
        ? auth.startsWith("Bearer ")
          ? deps.oauth.validateToken(auth.slice(7))?.userId
          : null
        : requireUser(c, deps);
    if (!userId && auth === undefined && c.req.header("accept")?.includes("text/html")) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${rootUrl(config.issuer, MCP_RESOURCE_METADATA_PATH)}"`);
      return c.html(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to download</title><body><h1>Sign in to download</h1><p>This file is private. <a href="/login">Sign in with Telegram</a>, then reopen this link before it expires. If it has expired, ask your assistant to prepare the original message again.</p></body></html>',
        401,
      );
    }
    if (!userId)
      return c.json(
        {
          error: "unauthorized",
          loginUrl: `${config.issuer}/login`,
          message: "Sign in, then reopen the download link before it expires.",
        },
        401,
        {
          "WWW-Authenticate": `Bearer resource_metadata="${rootUrl(config.issuer, MCP_RESOURCE_METADATA_PATH)}"`,
        },
      );
    if (!deps.downloads) return c.json({ error: "download_unavailable" }, 503);
    const item = deps.downloads.read(userId, c.req.param("id"));
    if (!item)
      return c.json({ error: "download_unavailable", message: "Prepare the original message again via MCP." }, 404);
    // Never render arbitrary HTML/SVG/documents on the OAuth origin. Even an
    // adversarial MIME or filename is returned as an attachment, not executed.
    const name = encodeURIComponent(item.metadata.fileName).replace(
      /['()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    c.header("Content-Disposition", `attachment; filename="media.bin"; filename*=UTF-8''${name}`);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Security-Policy", "sandbox; default-src 'none'");
    c.header("Content-Length", String(item.metadata.size));
    // HEAD doesn't consume the snapshot. GET is retryable until the fixed TTL;
    // MCP byte offsets are the resumable path, HTTP Range is not implemented.
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const end = Math.min(offset + DOWNLOAD_CHUNK_BYTES, item.bytes.length);
        controller.enqueue(item.bytes.subarray(offset, end));
        offset = end;
        if (offset === item.bytes.length) controller.close();
      },
    });
    return new Response(c.req.method === "HEAD" ? null : body, { headers: c.res.headers });
  });

  app.get("/uploads", async (c) => {
    const userId = requireUser(c, deps);
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
    const userId = requireUser(c, deps);
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
    const userId = requireUser(c, deps);
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
    const userId = requireUser(c, deps);
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
