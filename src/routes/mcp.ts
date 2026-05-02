import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { DestructiveGuard } from "../destructive-guard.js";
import { handleMcpRequest } from "../mcp-handler.js";
import type { OAuthProvider } from "../oauth.js";
import type { SessionManager } from "../session-manager.js";
import type { UploadStore } from "../upload-store.js";
import type { UsageTracker } from "../usage.js";

export interface McpRoutesDeps {
  oauth: OAuthProvider;
  sessions: SessionManager;
  usage: UsageTracker;
  destructive: DestructiveGuard;
  uploads: UploadStore;
}

/**
 * Registers MCP routes directly on the root app (not as a sub-app).
 *
 * Hono's sub-app mounted via `app.route("/mcp", sub)` + `sub.all("/")`
 * does not reliably match `/mcp/` (trailing slash) even with
 * `strict: false` on both apps — the double-match across app
 * boundaries loses the trailing slash. Registering on the root app
 * with explicit paths is the portable approach.
 */
export function registerMcpRoutes(app: Hono, { oauth, sessions, usage, destructive, uploads }: McpRoutesDeps): void {
  const corsMiddleware = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  });

  app.use("/mcp", corsMiddleware);
  app.use("/mcp/", corsMiddleware);

  const handler = async (c: Context) => {
    let userId: string | null = null;
    let clientName = "";

    const auth = c.req.header("Authorization");
    if (auth?.startsWith("Bearer ")) {
      const tokenInfo = oauth.validateToken(auth.slice(7));
      if (tokenInfo) {
        userId = tokenInfo.userId;
        clientName = tokenInfo.clientName;
      }
    }

    if (!userId) {
      userId = c.req.header("X-User-Id") || null;
    }

    if (!userId) {
      return c.json(
        {
          error: "unauthorized",
          message: "Bearer token required. Use OAuth 2.0 flow to authenticate.",
        },
        401,
      );
    }

    return handleMcpRequest(sessions, usage, oauth, destructive, uploads, userId, clientName, c.req.raw);
  };

  app.all("/mcp", handler);
  app.all("/mcp/", handler);
}
