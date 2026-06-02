import { Hono } from "hono";
import { AddAccountPage } from "../pages/AddAccountPage.js";
import { handleAddAccountQr } from "../qr-login.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";

export interface AccountsRoutesDeps {
  sessions: SessionManager;
}

/**
 * v2.32.0 multi-account routes.
 *
 * Single capability-token-protected entry point that any device with the URL
 * can open to attach a fresh Telegram identity to the owner who originally
 * called `telegram-accounts-add` from their MCP client.
 *
 * Token TTL is 10 min (set in the MCP tool); single-use; peek without consume
 * for the GET render, consume on the SSE EventSource open. If the token is
 * already used / expired / unknown, both endpoints 404 — no information leak
 * about which case it was.
 */
export function createAccountsRoutes({ sessions }: AccountsRoutesDeps): Hono {
  const app = new Hono();

  // HTML page — uses peekAddAccountToken so a reload during the QR window still
  // renders. The token isn't consumed until the EventSource opens (next route).
  app.get("/add/:token", async (c) => {
    const token = c.req.param("token");
    const peeked = sessions.peekAddAccountToken(token);
    if (!peeked) return c.text("Link expired or already used", 404);
    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("add-account", {
        token,
        label: peeked.label,
        locale,
        scripts: islandScripts("language-switcher", "qr-flow"),
      });
      return c.html(html);
    }
    return c.html(<AddAccountPage token={token} label={peeked.label} />);
  });

  // SSE stream — consumes the token (single-use); reusing the same URL after
  // success or after this endpoint opens will 404.
  app.get("/add/:token/qr", async (c) => {
    const token = c.req.param("token");
    const consumed = sessions.consumeAddAccountToken(token);
    if (!consumed) return c.text("Link expired or already used", 404);

    const stream = await handleAddAccountQr(sessions, consumed.ownerUserId, consumed.label, c.req.raw.signal);

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
