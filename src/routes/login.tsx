import { Hono } from "hono";
import { isAdminSessionValid } from "../auth/admin.js";
import { config } from "../config.js";
import { LoginPage } from "../pages/LoginPage.js";
import { handleQrLogin } from "../qr-login.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";

export interface LoginRoutesDeps {
  sessions: SessionManager;
}

export function createLoginRoutes({ sessions }: LoginRoutesDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    if (config.singleOperatorMode && !isAdminSessionValid(c.req.header("cookie"))) {
      return c.redirect("/admin-login", 302);
    }

    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("login", {
        locale,
        scripts: islandScripts("language-switcher", "qr-flow"),
      });
      return c.html(html);
    }
    return c.html(<LoginPage />);
  });

  app.get("/qr", async (c) => {
    let userId: string;
    if (config.singleOperatorMode) {
      if (!isAdminSessionValid(c.req.header("cookie"))) {
        return c.text("Forbidden", 403);
      }
      // Single-operator mode: never trust the caller-supplied `userId` query
      // param as the session key — see the fixed docs/superpowers spec for
      // the hijack this closes. The param may still arrive from the
      // client-side qr-flow island (it has its own userId input for the
      // multi-tenant flow) but is ignored here.
      userId = config.ownerUserId;
    } else {
      // Multi-tenant (default): upstream's original self-service flow — the
      // visitor picks which Telegram identity to log into.
      const queryUserId = c.req.query("userId");
      if (!queryUserId) {
        return c.text("userId required", 400);
      }
      userId = queryUserId;
    }

    const stream = await handleQrLogin(sessions, userId, c.req.raw.signal);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
