/**
 * Lightweight structured logger that sends logs to SigNoz via OTLP HTTP.
 * Zero external dependencies — uses Node.js built-in fetch.
 * Also logs to console for local/docker visibility.
 */

import { createHmac } from "node:crypto";
import { config } from "./config.js";

const OTLP_ENDPOINT = config.signozEndpoint;
const SERVICE_NAME = config.logServiceName;
const BATCH_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 50;

/**
 * Return a user identifier safe for logs. When LOG_USER_IDS=false, returns
 * a short stable HMAC-SHA256 prefix instead of the raw Telegram user id.
 * Uses LOG_HASH_SALT as HMAC key to prevent rainbow-table lookup of hashes
 * from a log dump back to Telegram user IDs (numeric ID space is small).
 */
export function logUser(userId: string | number | undefined): string {
  if (userId === undefined || userId === null) return "";
  const raw = String(userId);
  if (config.logUserIds) return raw;
  return `u:${createHmac("sha256", config.logHashSalt).update(raw).digest("hex").slice(0, 10)}`;
}

type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";
const SEVERITY_NUMBER: Record<Severity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: { key: string; value: { stringValue: string } }[];
}

const batch: LogRecord[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function toAttributes(attrs: Record<string, string | number | undefined>) {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({
      key,
      value: { stringValue: String(value) },
    }));
}

async function flush() {
  if (batch.length === 0) return;
  if (!OTLP_ENDPOINT) {
    batch.length = 0; // drain — no endpoint configured, keep console logs only
    return;
  }
  const records = batch.splice(0);

  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeLogs: [
          {
            scope: { name: SERVICE_NAME },
            logRecords: records,
          },
        ],
      },
    ],
  };

  try {
    await fetch(`${OTLP_ENDPOINT}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silent fail — don't crash app if SigNoz is down
  }
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, BATCH_INTERVAL_MS);
}

function log(severity: Severity, message: string, attrs: Record<string, string | number | undefined> = {}) {
  // Console output (keeps docker logs working)
  const prefix = attrs.component ? `[${attrs.component}]` : "";
  if (severity === "ERROR") {
    console.error(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }

  // Skip batching entirely when no remote endpoint is configured
  if (!OTLP_ENDPOINT) return;

  // OTLP batch
  batch.push({
    timeUnixNano: String(Date.now() * 1_000_000),
    severityNumber: SEVERITY_NUMBER[severity],
    severityText: severity,
    body: { stringValue: message },
    attributes: toAttributes(attrs),
  });

  if (batch.length >= MAX_BATCH_SIZE) {
    flush();
  } else {
    scheduleFlush();
  }
}

export const logger = {
  debug: (msg: string, attrs?: Record<string, string | number | undefined>) => log("DEBUG", msg, attrs),
  info: (msg: string, attrs?: Record<string, string | number | undefined>) => log("INFO", msg, attrs),
  warn: (msg: string, attrs?: Record<string, string | number | undefined>) => log("WARN", msg, attrs),
  error: (msg: string, attrs?: Record<string, string | number | undefined>) => log("ERROR", msg, attrs),

  /** Flush all pending logs (call before process exit) */
  flush,
};
