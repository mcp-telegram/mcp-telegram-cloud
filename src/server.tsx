// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 overpod
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { BotClient } from "./bot/api.js";
import { Subscribers } from "./bot/subscribers.js";
import { config, SENTINEL_LOG_HASH_SALT } from "./config.js";
import { DestructiveGuard } from "./destructive-guard.js";
import { logger } from "./logger.js";
import { accessLog } from "./middleware/access-log.js";
import { OAuthProvider } from "./oauth.js";
import { installRateLimiterEventListener } from "./rate-limiter-events.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createBotWebhookRoutes, createBroadcastRoute } from "./routes/bot.js";
import { createLoginRoutes } from "./routes/login.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { createMyRoutes } from "./routes/my.js";
import { createOAuthRoutes, createOAuthWellKnownRoutes } from "./routes/oauth.js";
import { createStaticRoutes } from "./routes/static.js";
import { SessionManager } from "./session-manager.js";
import { purgeUrlFetchOrphans } from "./tools/uploads.js";
import { UploadStore } from "./upload-store.js";
import { UsageTracker } from "./usage.js";

// Forward [rate-limiter] event {...} stderr lines from @overpod/mcp-telegram
// into structured logger.warn() calls so SigNoz can aggregate by event/context.
// Must run before any TelegramService is constructed.
installRateLimiterEventListener();

// PII-hashing footgun: hashed-user-id mode (the default) promises rainbow-table
// protection, but with the shipped sentinel salt the hash provides none — anyone
// with the source can rebuild the mapping. Warn loudly so it surfaces in logs.
if (!config.logUserIds && config.logHashSalt === SENTINEL_LOG_HASH_SALT) {
  logger.warn(
    "LOG_USER_IDS unset/false but LOG_HASH_SALT is unset — using sentinel default. Set a real salt; see docs/configuration.md#log_user_ids--log_hash_salt",
    {
      component: "config",
      event: "log_hash_salt.sentinel",
    },
  );
}

const sessions = new SessionManager();
const oauth = new OAuthProvider({ issuer: config.issuer, db: sessions.getDb() });
const usage = new UsageTracker(sessions.getDb());
const destructive = new DestructiveGuard(
  sessions.getDb(),
  config.destructiveDailyLimit,
  `${config.issuer}/my/settings`,
);
const uploads = new UploadStore(
  sessions.getDb(),
  config.uploadFileMaxBytes,
  config.uploadQuotaBytes,
  config.uploadTtlSeconds * 1000,
);

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

// Periodic purge of old destructive_audit rows (retention policy)
if (config.destructiveAuditRetentionDays > 0) {
  setInterval(() => {
    const removed = destructive.purgeOldRows(config.destructiveAuditRetentionDays);
    if (removed > 0) {
      logger.info(`Purged ${removed} old destructive_audit rows`, {
        component: "destructive",
        event: "retention.purge",
        removed,
        retentionDays: config.destructiveAuditRetentionDays,
      });
    }
  }, 24 * 3600_000);
}

// Phase X — periodic purge of expired pending uploads (TTL: config.uploadTtlSeconds).
// Sweep at 1/4 of TTL so any expired row is gone within ~ttl/4 walltime.
const uploadPurgeIntervalMs = Math.max(60_000, (config.uploadTtlSeconds * 1000) / 4);
// 5 min — long enough that a healthy in-flight URL-fetch (timeout 30s + send to Telegram) finishes
// before a stale orphan from a SIGKILL'd predecessor would be deleted, short enough to bound disk.
const URL_FETCH_ORPHAN_MAX_AGE_MS = 5 * 60_000;

// Boot-time wipe: any URL-fetch leftovers from a previous process (SIGKILL between writeFile
// and cleanup, OOM, etc.) are stale by definition — no in-flight tool call can own them.
purgeUrlFetchOrphans(0)
  .then((n) => {
    if (n > 0) {
      logger.info(`Boot wipe removed ${n} URL-fetch orphans`, {
        component: "uploads",
        event: "uploads.boot_wipe",
        removed: n,
      });
    }
  })
  .catch((e) => {
    logger.warn(`Boot wipe of URL-fetch dir failed: ${(e as Error).message}`, {
      component: "uploads",
      event: "uploads.boot_wipe_failed",
    });
  });

setInterval(async () => {
  try {
    const removedPending = await uploads.purgeExpired();
    if (removedPending > 0) {
      logger.info(`Purged ${removedPending} expired pending uploads`, {
        component: "uploads",
        event: "uploads.purge",
        removed: removedPending,
      });
    }
    const removedOrphans = await purgeUrlFetchOrphans(URL_FETCH_ORPHAN_MAX_AGE_MS);
    if (removedOrphans > 0) {
      logger.info(`Purged ${removedOrphans} URL-fetch orphans`, {
        component: "uploads",
        event: "uploads.urlfetch_purge",
        removed: removedOrphans,
      });
    }
  } catch (e) {
    logger.warn(`Upload purge failed: ${(e as Error).message}`, {
      component: "uploads",
      event: "uploads.purge_failed",
    });
  }
}, uploadPurgeIntervalMs);

// strict: false makes Hono treat `/mcp` and `/mcp/` as the same route
// (and same for all other paths) — ChatGPT and some proxies send trailing
// slash to the MCP endpoint, and default strict mode 404s those.
const app = new Hono({ strict: false });

app.use("*", accessLog);
app.route("/", createStaticRoutes({ sessions }));
app.route("/", createOAuthWellKnownRoutes(oauth));
app.route("/oauth", createOAuthRoutes({ oauth, sessions }));
app.route("/api", createAdminRoutes({ oauth, sessions, usage }));
registerMcpRoutes(app, { oauth, sessions, usage, destructive, uploads });
app.route("/login", createLoginRoutes({ sessions }));
app.route("/my", createMyRoutes({ destructive, sessions, uploads }));

if (botEnabled && botClient && subscribers) {
  const botDeps = { client: botClient, subscribers, webhookSecret: config.botWebhookSecret };
  app.route("/bot", createBotWebhookRoutes(botDeps));
  app.route("/api", createBroadcastRoute(botDeps));
  logger.info("Broadcast bot routes mounted", {
    component: "bot",
    event: "bot.mount",
    username: config.botUsername, // telemetry-allow: public bot handle, not user PII
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
