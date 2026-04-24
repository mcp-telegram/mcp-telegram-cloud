import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { handleMcpRequest } from "../mcp-handler.js";
import type { OAuthProvider } from "../oauth.js";
import type { SessionManager } from "../session-manager.js";
import type { UsageTracker } from "../usage.js";

export interface McpRoutesDeps {
  oauth: OAuthProvider;
  sessions: SessionManager;
  usage: UsageTracker;
}

/**
 * Registers MCP endpoint on both `/mcp` and `/mcp/` of the passed app.
 * We register directly (not via sub-app + app.route) because Hono's
 * `app.route("/mcp", sub)` with `sub.all("*")` doesn't reliably match
 * bare `/mcp/` (trailing slash) on all runtimes. ChatGPT and some
 * clients send trailing slash, so we must accept both forms.
 */
export function registerMcpRoutes(app: Hono, { oauth, sessions, usage }: McpRoutesDeps): void {
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

    return handleMcpRequest(sessions, usage, oauth, userId, clientName, c.req.raw);
  };

  app.all("/mcp", handler);
  app.all("/mcp/", handler);
}
