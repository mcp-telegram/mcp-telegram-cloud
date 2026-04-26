// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 overpod
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { BotClient } from "./bot/api.js";
import { Subscribers } from "./bot/subscribers.js";
import { config, SENTINEL_LOG_HASH_SALT } from "./config.js";
import { logger } from "./logger.js";
import { accessLog } from "./middleware/access-log.js";
import { OAuthProvider } from "./oauth.js";
import { installRateLimiterEventListener } from "./rate-limiter-events.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createBotWebhookRoutes, createBroadcastRoute } from "./routes/bot.js";
import { createLoginRoutes } from "./routes/login.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { createOAuthRoutes, createOAuthWellKnownRoutes } from "./routes/oauth.js";
import { createStaticRoutes } from "./routes/static.js";
import { SessionManager } from "./session-manager.js";
import { UsageTracker } from "./usage.js";

// Forward [rate-limiter] event {...} stderr lines from @overpod/mcp-telegram
// into structured logger.warn() calls so SigNoz can aggregate by event/context.
// Must run before any TelegramService is constructed.
installRateLimiterEventListener();

// PII-hashing footgun: LOG_USER_IDS=false promises hashed user IDs, but with the
// shipped sentinel salt the hash provides zero rainbow-table protection (anyone
// with the source can rebuild the mapping). Warn loudly so it surfaces in logs.
if (!config.logUserIds && config.logHashSalt === SENTINEL_LOG_HASH_SALT) {
  logger.warn(
    "LOG_USER_IDS=false but LOG_HASH_SALT is unset — using sentinel default. Set a real salt; see docs/configuration.md#log_user_ids--log_hash_salt",
    {
      component: "config",
      event: "log_hash_salt.sentinel",
    },
  );
}

const sessions = new SessionManager();
const oauth = new OAuthProvider({ issuer: config.issuer, db: sessions.getDb() });
const usage = new UsageTracker(sessions.getDb());

// Optional broadcast bot (Phase 0.1). Either configure all three vars or none —
// partial config almost always means a deploy mistake (bot answers /start with silence).
const botVars = {
  BOT_TOKEN: config.botToken,
  BOT_USERNAME: config.botUsername,
  BOT_WEBHOOK_SECRET: config.botWebhookSecret,
};
const botSetCount = Object.values(botVars).filter(Boolean).length;
if (botSetCount > 0 && botSetCount < 3) {
  const missing = Object.entries(botVars)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  throw new Error(`Bot env partial config: missing ${missing.join(", ")}. Set all three or none.`);
}
const botEnabled = botSetCount === 3;
const subscribers = botEnabled ? new Subscribers(sessions.getDb()) : null;
const botClient = botEnabled ? new BotClient(config.botToken) : null;

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
registerMcpRoutes(app, { oauth, sessions, usage });
app.route("/login", createLoginRoutes({ sessions }));

if (botEnabled && botClient && subscribers) {
  const botDeps = { client: botClient, subscribers, webhookSecret: config.botWebhookSecret };
  app.route("/bot", createBotWebhookRoutes(botDeps));
  app.route("/api", createBroadcastRoute(botDeps));
  logger.info("Broadcast bot routes mounted", {
    component: "bot",
    event: "bot.mount",
    username: config.botUsername,
  });
}

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
