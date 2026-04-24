import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { accessLog } from "./middleware/access-log.js";
import { OAuthProvider } from "./oauth.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createLoginRoutes } from "./routes/login.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { createOAuthRoutes, createOAuthWellKnownRoutes } from "./routes/oauth.js";
import { createStaticRoutes } from "./routes/static.js";
import { SessionManager } from "./session-manager.js";
import { UsageTracker } from "./usage.js";

const sessions = new SessionManager();
const oauth = new OAuthProvider({ issuer: config.issuer, db: sessions.getDb() });
const usage = new UsageTracker(sessions.getDb());

// Periodic cleanup of expired OAuth codes/tokens
setInterval(() => oauth.cleanup(), 3600_000);

// Periodic purge of old usage_log rows (retention policy)
if (config.usageLogRetentionDays > 0) {
  setInterval(() => {
    const removed = usage.purgeOldLogs(config.usageLogRetentionDays);
    if (removed > 0) {
      logger.info(`Purged ${removed} old usage_log rows`, {
        component: "usage",
        event: "retention.purge",
        removed,
        retentionDays: config.usageLogRetentionDays,
      });
    }
  }, 24 * 3600_000);
}

// strict: false makes Hono treat `/mcp` and `/mcp/` as the same route
// (and same for all other paths) — ChatGPT and some proxies send trailing
// slash to the MCP endpoint, and default strict mode 404s those.
const app = new Hono({ strict: false });

app.use("*", accessLog);
app.route("/", createStaticRoutes({ sessions }));
app.route("/", createOAuthWellKnownRoutes(oauth));
app.route("/oauth", createOAuthRoutes({ oauth, sessions }));
app.route("/api", createAdminRoutes({ oauth, sessions, usage }));
app.route("/mcp", createMcpRoutes({ oauth, sessions, usage }));
app.route("/login", createLoginRoutes({ sessions }));

logger.info(`${config.brandName} starting on port ${config.port}`, {
  component: "cloud",
  event: "server.start",
  issuer: config.issuer,
});
serve({ fetch: app.fetch, port: config.port });

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    logger.info(`Received ${sig}, shutting down`, { component: "cloud", event: "server.stop" });
    await logger.flush();
    process.exit(0);
  });
}
