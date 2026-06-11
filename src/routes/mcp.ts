import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { config } from "../config.js";
import type { DestructiveGuard } from "../destructive-guard.js";
import { handleMcpRequest } from "../mcp-handler.js";
import type { OAuthProvider } from "../oauth.js";
import { mcpRateLimit } from "../rate-limit.js";
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
  // Per-token rate limit + request body cap (audit M1 / /mcp throttle). CORS
  // runs first so preflight OPTIONS short-circuits before these.
  app.use("/mcp", mcpRateLimit);
  app.use("/mcp/", mcpRateLimit);
  const mcpBodyLimit = bodyLimit({ maxSize: config.maxJsonBodyBytes });
  app.use("/mcp", mcpBodyLimit);
  app.use("/mcp/", mcpBodyLimit);

  const handler = async (c: Context) => {
    let userId: string | null = null;
    let clientName = "";

    // Identity comes ONLY from a validated OAuth Bearer token. Never trust a
    // request header for the user id: userId is a *public* identifier (Telegram
    // username / numeric id), so any header-derived identity would let an
    // unauthenticated caller name an arbitrary victim and drive their Telegram
    // session — a full pre-auth account takeover that bypasses OAuth, PKCE and
    // at-rest encryption (the server decrypts on demand for whatever id it's
    // handed). See security audit 2026-06-11.
    const auth = c.req.header("Authorization");
    if (auth?.startsWith("Bearer ")) {
      const tokenInfo = oauth.validateToken(auth.slice(7));
      if (tokenInfo) {
        userId = tokenInfo.userId;
        clientName = tokenInfo.clientName;
      }
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
