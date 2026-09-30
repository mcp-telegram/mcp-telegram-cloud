import { type Context, Hono } from "hono";
import { config } from "../config.js";
import {
  CHATROOST_ICON_PNG_32,
  CHATROOST_ICON_PNG_128,
  CHATROOST_ICON_PNG_256,
  CHATROOST_ICON_PNG_512,
  CHATROOST_ICON_SVG,
} from "../icon.js";
import { getActiveMcpSessionsTotal, isDraining } from "../lifecycle.js";
import { readClientAsset } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";

export interface StaticRoutesDeps {
  sessions: SessionManager;
}

export function createStaticRoutes({ sessions }: StaticRoutesDeps): Hono {
  const app = new Hono();

  // Served only if OPENAI_APPS_CHALLENGE is configured — silent 404 otherwise.
  app.get("/.well-known/openai-apps-challenge", (c) =>
    config.openaiAppsChallenge ? c.text(config.openaiAppsChallenge) : c.notFound(),
  );

  // Functional-only host — disallow all crawlers. Pairs with the
  // `X-Robots-Tag: noindex` header set globally in server.tsx.
  app.get("/robots.txt", (c) =>
    c.text("User-agent: *\nDisallow: /\n", 200, { "Content-Type": "text/plain; charset=utf-8" }),
  );

  // Hashed client island bundles built by the `app/` workspace (Vite). Names
  // are content-hashed, so cache immutably. `:path{.+}` captures the rest of
  // the URL (e.g. `assets/language-switcher-pR8QhwXz.js`).
  app.get("/app-assets/:path{.+}", (c) => {
    const body = readClientAsset(c.req.param("path"));
    if (body === null) return c.notFound();
    const isCss = c.req.param("path").endsWith(".css");
    return c.body(body, 200, {
      "Content-Type": isCss ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  app.get("/health", (c) => {
    const body = {
      status: isDraining() ? "draining" : "ok",
      activeSessions: sessions.getActiveCount(),
      activeMcpSessions: getActiveMcpSessionsTotal(),
    };
    // 503 during drain so Traefik / Swarm healthchecks fail-fast and
    // remove this task from the LB pool. Body still carries detail so
    // dashboards/ops can see why.
    return c.json(body, isDraining() ? 503 : 200);
  });

  // Brand icons (Chatroost mark, see src/icon.ts). `serverInfo.icons` in mcp-handler points at
  // these; /favicon.ico gives this host a favicon for clients and directories that fetch one.
  const image = (body: string | Uint8Array, type: string) => (c: Context) =>
    c.body(typeof body === "string" ? body : new Uint8Array(body), 200, {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400",
    });

  app.get("/icon.svg", image(CHATROOST_ICON_SVG, "image/svg+xml"));
  // PNG variants for clients that don't render SVG (e.g. ChatGPT app avatar).
  app.get("/icon.png", image(CHATROOST_ICON_PNG_128, "image/png"));
  app.get("/icon-256.png", image(CHATROOST_ICON_PNG_256, "image/png"));
  app.get("/icon-512.png", image(CHATROOST_ICON_PNG_512, "image/png"));
  app.get("/favicon.ico", image(CHATROOST_ICON_PNG_32, "image/png"));

  return app;
}
