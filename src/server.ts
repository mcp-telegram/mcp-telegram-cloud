import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleMcpRequest } from "./mcp-handler.js";
import { SessionManager } from "./session-manager.js";

const app = new Hono();
const sessions = new SessionManager();

const PORT = Number(process.env.PORT) || 3000;

// CORS for browser-based MCP clients
app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "mcp-session-id", "X-User-Id"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  }),
);

// Health check
app.get("/health", (c) =>
  c.json({
    status: "ok",
    activeSessions: sessions.getActiveCount(),
  }),
);

// MCP endpoint — handles POST (messages), GET (SSE), DELETE (session close)
app.all("/mcp", async (c) => {
  // TODO: Replace with OAuth 2.0 middleware
  const userId = c.req.header("X-User-Id") || "anonymous";
  return handleMcpRequest(sessions, userId, c.req.raw);
});

// QR login page (web UI)
app.get("/login", (c) => {
  // TODO: Web QR login UI
  return c.html("<h1>Telegram QR Login</h1><p>Coming soon</p>");
});

console.log(`[cloud] MCP Telegram Cloud starting on port ${PORT}`);
serve({ fetch: app.fetch, port: PORT });
