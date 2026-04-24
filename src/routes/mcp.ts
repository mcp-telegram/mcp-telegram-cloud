import { Hono } from "hono";
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

export function createMcpRoutes({ oauth, sessions, usage }: McpRoutesDeps): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  app.all("*", async (c) => {
    // Extract userId + clientName from Bearer token (OAuth 2.0) or fallback to X-User-Id (dev)
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
  });

  return app;
}
