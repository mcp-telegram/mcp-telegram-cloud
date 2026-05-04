import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { BotClient } from "../bot/api.js";
import { TELEGRAM_TEXT_LIMIT, truncateForTelegram } from "../bot/api.js";
import { logger } from "../logger.js";

export interface AlertRoutesDeps {
  client: BotClient;
  /** Shared secret SigNoz sends in `X-Webhook-Secret`. */
  webhookSecret: string;
  /** Numeric Telegram chat where alerts are posted. */
  alertChatId: number;
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface SignozAlert {
  status?: string;
  labels?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  startsAt?: string;
  generatorURL?: string;
}

interface SignozPayload {
  receiver?: string;
  status?: string;
  alerts?: SignozAlert[];
}

const isStringRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const STATUS_PREFIX: Record<string, string> = {
  firing: "🔥 FIRING",
  resolved: "✅ RESOLVED",
};

/** Format a single alert into a 1–4 line plaintext block. */
function formatAlert(a: SignozAlert): string {
  const status = typeof a.status === "string" ? a.status.toLowerCase() : "firing";
  const prefix = STATUS_PREFIX[status] ?? `• ${status.toUpperCase()}`;

  const labels = isStringRecord(a.labels) ? a.labels : {};
  const annotations = isStringRecord(a.annotations) ? a.annotations : {};

  const name =
    (typeof labels.alertname === "string" && labels.alertname) ||
    (typeof annotations.title === "string" && annotations.title) ||
    "alert";

  const lines: string[] = [`${prefix}: ${name}`];

  const summary = annotations.summary ?? annotations.description;
  if (typeof summary === "string" && summary.trim()) lines.push(summary.trim());

  const labelBits: string[] = [];
  for (const k of ["host.name", "hostname", "service", "service.name", "severity", "mountpoint"]) {
    const v = labels[k];
    if (typeof v === "string" && v.trim()) labelBits.push(`${k}=${v}`);
  }
  if (labelBits.length > 0) lines.push(labelBits.join(" "));

  if (typeof a.generatorURL === "string" && /^https?:\/\//i.test(a.generatorURL)) {
    lines.push(a.generatorURL);
  }

  return lines.join("\n");
}

export function formatPayload(payload: SignozPayload): string {
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  if (alerts.length === 0) {
    const status = typeof payload.status === "string" ? payload.status : "unknown";
    return `SigNoz webhook received with no alerts (status=${status})`;
  }
  const blocks = alerts.map(formatAlert);
  return truncateForTelegram(blocks.join("\n\n"));
}

/**
 * SigNoz webhook → Telegram bridge.
 *
 * Mount under `/api`: SigNoz Alertmanager `webhook_url` =
 * `https://mcp-telegram.com/api/alerts/signoz` and `webhook_password`/header
 * carries the shared secret. Each request POSTs a single Telegram message to
 * `alertChatId` (truncated to 4096 chars). 200 on success keeps SigNoz from
 * retrying; on transient bot errors we 500 so the alertmanager queue drains
 * naturally.
 */
export function createAlertRoutes({ client, webhookSecret, alertChatId }: AlertRoutesDeps): Hono {
  const app = new Hono();

  app.post("/alerts/signoz", async (c) => {
    if (!safeEqual(c.req.header("X-Webhook-Secret"), webhookSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let payload: SignozPayload;
    try {
      payload = (await c.req.json()) as SignozPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const text = formatPayload(payload);
    const result = await client.sendMessage(alertChatId, text);

    if (!result.ok) {
      logger.error("Alert webhook send failed", {
        component: "alerts",
        event: "alerts.send_failed",
        status: String(result.errorCode),
        error: result.description,
      });
      return c.json({ error: "telegram send failed", code: result.errorCode }, 500);
    }

    logger.info("Alert webhook delivered", {
      component: "alerts",
      event: "alerts.delivered",
      count: Array.isArray(payload.alerts) ? payload.alerts.length : 0,
      length: Math.min(text.length, TELEGRAM_TEXT_LIMIT),
    });
    return c.json({ ok: true }, 200);
  });

  return app;
}
