import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { isAdminAuthorized } from "../auth/admin.js";
import type { BotClient } from "../bot/api.js";
import { broadcastTo } from "../bot/api.js";
import type { Subscribers } from "../bot/subscribers.js";
import { handleBotUpdate } from "../bot/webhook.js";
import { logger } from "../logger.js";

export interface BotRoutesDeps {
  client: BotClient;
  subscribers: Subscribers;
  /** Random secret used both as URL path and X-Telegram-Bot-Api-Secret-Token header. */
  webhookSecret: string;
}

/** Constant-time string compare with length guard. Avoids leaking matched-prefix length via `!==`. */
function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bot webhook + admin broadcast endpoints.
 *
 * Mount at root: `/bot/webhook/<secret>` (Telegram POST) and `/api/broadcast`
 * (admin POST). Only the latter is grouped under `/api`; the bot webhook lives
 * outside `/api` so admin auth doesn't accidentally protect it from Telegram.
 */
export function createBotWebhookRoutes({ client, subscribers, webhookSecret }: BotRoutesDeps): Hono {
  const app = new Hono();

  app.post("/webhook/:secret", async (c) => {
    // Defense in depth: secret must match both URL param AND the secret_token header
    // (the latter is set by Telegram per setWebhook). Either alone is enough; both is safer.
    const urlOk = safeEqual(c.req.param("secret"), webhookSecret);
    const headerOk = safeEqual(c.req.header("X-Telegram-Bot-Api-Secret-Token"), webhookSecret);
    if (!urlOk || !headerOk) {
      return c.text("not found", 404);
    }

    let update: unknown = null;
    try {
      update = await c.req.json();
    } catch {
      // Malformed JSON from a non-Telegram caller. Don't make Telegram retry — return 200.
      logger.warn("Bot webhook got non-JSON body", { component: "bot", event: "webhook.bad_json" });
      return c.text("ok", 200);
    }

    try {
      await handleBotUpdate(update as Parameters<typeof handleBotUpdate>[0], client, subscribers);
    } catch (err) {
      logger.error("Bot webhook handler failed", {
        component: "bot",
        event: "webhook.error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Always 200 — Telegram retries non-2xx aggressively, but for our case any error
    // is in our code, not Telegram's, so we don't want them to flood us with retries.
    return c.text("ok", 200);
  });

  return app;
}

/**
 * Admin broadcast: POST /api/broadcast { message: string }.
 * Returns 202 immediately and runs the fan-out in the background — broadcasts
 * for hundreds of recipients exceed typical reverse-proxy timeouts. A
 * module-level mutex prevents two concurrent broadcasts from doubling the
 * effective send-rate (each pacing 25/sec → combined 50/sec → ban risk).
 */
export function createBroadcastRoute({ client, subscribers }: BotRoutesDeps): Hono {
  const app = new Hono();
  let broadcasting = false;

  app.post("/broadcast", async (c) => {
    if (!isAdminAuthorized(c.req.header("Authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: { message?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return c.json({ error: "message required (non-empty string)" }, 400);

    if (broadcasting) {
      return c.json({ error: "another broadcast is already running" }, 409);
    }

    const recipients = subscribers.listActive();
    if (recipients.length === 0) {
      return c.json({ ok: true, sent: 0, failed: 0, pruned: 0, totalRecipients: 0, status: "skipped" }, 200);
    }

    broadcasting = true;
    logger.info("Broadcast started", {
      component: "bot",
      event: "broadcast.start",
      recipients: recipients.length,
      length: message.length,
    });

    // Fire-and-forget: caller gets 202 and we keep working.
    void (async () => {
      try {
        const result = await broadcastTo(client, recipients, message);
        subscribers.bulkUnsubscribe(result.toUnsubscribe);
        logger.info("Broadcast finished", {
          component: "bot",
          event: "broadcast.done",
          sent: result.sent,
          failed: result.failed,
          pruned: result.toUnsubscribe.length,
        });
      } catch (err) {
        logger.error("Broadcast crashed", {
          component: "bot",
          event: "broadcast.crash",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        broadcasting = false;
      }
    })();

    return c.json({ ok: true, accepted: true, totalRecipients: recipients.length }, 202);
  });

  return app;
}
