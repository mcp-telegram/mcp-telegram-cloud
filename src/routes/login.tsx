import { Hono } from "hono";
import { LoginPage } from "../pages/LoginPage.js";
import { handleQrLogin } from "../qr-login.js";
import type { SessionManager } from "../session-manager.js";

export interface LoginRoutesDeps {
  sessions: SessionManager;
}

export function createLoginRoutes({ sessions }: LoginRoutesDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(<LoginPage />));

  app.get("/qr", async (c) => {
    const userId = c.req.query("userId");
    if (!userId) {
      return c.text("userId required", 400);
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
