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
 * Registers MCP endpoint matching both `/mcp` and `/mcp/`.
 *
 * Hono's path matching on `/mcp/` (trailing slash) is inconsistent
 * between Node runtimes — `app.all("/mcp/", h)` matches locally on
 * darwin/node but misses on alpine/musl in production. To avoid
 * relying on that behavior, we install a global middleware that
 * inspects `c.req.path` and routes manually, falling through to
 * the rest of the app for non-MCP paths.
 */
export function registerMcpRoutes(app: Hono, { oauth, sessions, usage }: McpRoutesDeps): void {
  const corsMiddleware = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  });

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

  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path !== "/mcp" && path !== "/mcp/") {
      return next();
    }
    let response: Response | undefined;
    await corsMiddleware(c, async () => {
      response = await handler(c);
    });
    return response ?? c.res;
  });
}
