/**
 * Lightweight structured logger that sends logs to SigNoz via OTLP HTTP.
 * Zero external dependencies — uses Node.js built-in fetch.
 * Also logs to console for local/docker visibility.
 */

const OTLP_ENDPOINT = process.env.SIGNOZ_ENDPOINT || "http://193.169.52.83:4318";
const SERVICE_NAME = "mcp-telegram-cloud";
const BATCH_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 50;

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

let batch: LogRecord[] = [];
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
