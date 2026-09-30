import { Hono } from "hono";
import type { OAuthProvider } from "../oauth.js";
import { LoginPage } from "../pages/LoginPage.js";
import { handleQrLogin } from "../qr-login.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";

export interface LoginRoutesDeps {
  sessions: SessionManager;
  oauth: Pick<OAuthProvider, "createBrowserHandoff">;
}

export function createLoginRoutes({ sessions, oauth }: LoginRoutesDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
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
    const userId = c.req.query("userId");
    if (!userId) {
      return c.text("userId required", 400);
    }

    const stream = await handleQrLogin(sessions, userId, c.req.raw.signal, oauth);

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
