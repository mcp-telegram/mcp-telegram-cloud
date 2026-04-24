import { Hono } from "hono";
import { config } from "../config.js";
import { TELEGRAM_ICON_SVG } from "../icon.js";
import { LandingPage } from "../pages/LandingPage.js";
import { PrivacyPage } from "../pages/PrivacyPage.js";
import { TermsPage } from "../pages/TermsPage.js";
import type { SessionManager } from "../session-manager.js";

export interface StaticRoutesDeps {
  sessions: SessionManager;
}

export function createStaticRoutes({ sessions }: StaticRoutesDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(<LandingPage />));
  app.get("/privacy", (c) => c.html(<PrivacyPage />));
  app.get("/terms", (c) => c.html(<TermsPage />));

  // Served only if OPENAI_APPS_CHALLENGE is configured — silent 404 otherwise.
  app.get("/.well-known/openai-apps-challenge", (c) =>
    config.openaiAppsChallenge ? c.text(config.openaiAppsChallenge) : c.notFound(),
  );

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      activeSessions: sessions.getActiveCount(),
    }),
  );

  app.get("/icon.svg", (c) => {
    return c.body(TELEGRAM_ICON_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  return app;
}
