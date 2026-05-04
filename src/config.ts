/** Sentinel default for LOG_HASH_SALT — checked at startup to flag insecure
 * configs. Exported so the warning in server.tsx stays in sync if the value
 * is rotated. */
export const SENTINEL_LOG_HASH_SALT = "mcp-telegram-default-salt-rotate-me";

const required = (name: string, value: string | undefined): string => {
  if (!value?.trim()) {
    throw new Error(`Required env var ${name} is missing. See .env.example.`);
  }
  return value;
};

const optional = (value: string | undefined, fallback: string): string => value?.trim() || fallback;

/** Reject anything that isn't a plain http(s) URL. We render these values as
 * anchor `href` attributes on public pages, so a misconfigured operator
 * setting `javascript:alert(1)` would otherwise create an XSS sink that
 * fires for every visitor. Exported for unit tests; not for runtime use
 * outside config.ts. */
export const httpUrl = (name: string, value: string): string => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Env var ${name} must be an http(s) URL, got protocol "${parsed.protocol}".`);
    }
    return value;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Env var")) throw err;
    throw new Error(`Env var ${name} is not a valid URL: ${value}`);
  }
};

const DEFAULT_SOURCE_REPO_URL = "https://github.com/mcp-telegram/mcp-telegram-cloud";
const sourceRepoUrl = httpUrl(
  "SOURCE_REPO_URL",
  optional(process.env.SOURCE_REPO_URL, DEFAULT_SOURCE_REPO_URL),
).replace(/\/+$/, "");

/** Parse env int preserving 0 as valid. Replaces with fallback only on undefined/empty/NaN. */
const intOr = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Telemetry pipeline mode. Master kill-switch for outbound observability data.
 * - `local-only` (default): writes SQLite usage_log + console logs + in-memory error ring buffer for /api/observability. **Zero outbound** to SigNoz.
 * - `on`: same as local-only PLUS OTLP HTTP exporter to SigNoz (logs, metrics, traces in later phases).
 * - `off`: suppresses everything except SQLite usage_log (truly silent). */
export type TelemetryMode = "on" | "off" | "local-only";
/** Exported for unit tests; not for runtime use outside config.ts. */
export const parseTelemetryMode = (raw: string | undefined): TelemetryMode => {
  const v = raw?.trim().toLowerCase();
  if (v === "on" || v === "off" || v === "local-only") return v;
  return "local-only";
};

export const config = {
  /** Public origin (scheme + host, no trailing slash) — used in OAuth metadata,
   * absolute URLs in the landing/OAuth pages, and bot webhook setup. */
  issuer: required("ISSUER", process.env.ISSUER).replace(/\/+$/, ""),
  port: intOr(process.env.PORT, 3000),
  brandName: optional(process.env.BRAND_NAME, "MCP Telegram"),
  contactEmail: optional(process.env.CONTACT_EMAIL, ""),
  /** Telegram handle without leading @ (stripped once at load). */
  contactTelegram: optional(process.env.CONTACT_TELEGRAM, "").replace(/^@/, ""),
  /** GitHub (or other VCS) URL of the upstream open-source repo. Used in
   * Privacy/Terms pages to point users at the source. Self-hosters who
   * maintain a fork can override; default points at the canonical repo. */
  sourceRepoUrl,
  /** URL where users can report issues — defaults to {sourceRepoUrl}/issues. */
  issuesUrl: httpUrl("ISSUES_URL", optional(process.env.ISSUES_URL, `${sourceRepoUrl}/issues`)),
  /** Visible label for the issues link — overrideable so a self-hoster
   * pointing ISSUES_URL at GitLab / Jira / a mailto: bridge / a custom
   * tracker doesn't ship a misleading "GitHub Issues" label. */
  issuesLabel: optional(process.env.ISSUES_LABEL, "GitHub Issues"),

  openaiAppsChallenge: optional(process.env.OPENAI_APPS_CHALLENGE, ""),
  adminToken: process.env.ADMIN_TOKEN ?? "",

  telegramApiId: Number(required("TELEGRAM_API_ID", process.env.TELEGRAM_API_ID)),
  telegramApiHash: required("TELEGRAM_API_HASH", process.env.TELEGRAM_API_HASH),

  signozEndpoint: optional(process.env.SIGNOZ_ENDPOINT, ""),
  /** HTTP Basic auth credentials for OTLP ingest endpoint. Format: `"user:password"`.
   * Empty = no `Authorization` header sent (backward-compatible with unauthenticated ingest). */
  signozAuth: optional(process.env.SIGNOZ_AUTH, ""),
  logServiceName: optional(process.env.LOG_SERVICE_NAME, "mcp-telegram-cloud"),
  /** Master kill-switch for outbound telemetry. See {@link TelemetryMode}. Default `local-only`. */
  telemetryMode: parseTelemetryMode(process.env.MCP_TELEGRAM_TELEMETRY),
  /** When `true`, raw Telegram user IDs appear in logs. Default `false` (HMAC-hashed via {@link logHashSalt}).
   * Use `LOG_USER_IDS=true` only for local debugging — never in production. */
  logUserIds: process.env.LOG_USER_IDS === "true",
  /** HMAC key for hashing user IDs in logs (prevents rainbow-table lookup).
   * Defaults to {@link SENTINEL_LOG_HASH_SALT} so the app still boots on a
   * misconfigured deploy; server.tsx warns at startup when this combo is
   * insecure (LOG_USER_IDS=false + sentinel salt). */
  logHashSalt: optional(process.env.LOG_HASH_SALT, SENTINEL_LOG_HASH_SALT),

  databasePath: optional(process.env.DATABASE_PATH, "./data/cloud.db"),
  /** 0 = keep forever (no retention purge). */
  usageLogRetentionDays: intOr(process.env.USAGE_LOG_RETENTION_DAYS, 90),

  /** 0 = unlimited (rate-limit check effectively disabled). */
  freeTierLimit: intOr(process.env.FREE_TIER_LIMIT, 100),
  /** Separate daily quota for destructive tools (Phase 2.1). 0 = unlimited.
   * Counts only successful calls; denied attempts don't burn quota. */
  destructiveDailyLimit: intOr(process.env.DESTRUCTIVE_DAILY_LIMIT, 20),
  /** Retention for `destructive_audit` rows. 0 = keep forever. */
  destructiveAuditRetentionDays: intOr(process.env.DESTRUCTIVE_AUDIT_RETENTION_DAYS, 90),
  sessionCleanupDelayMinutes: intOr(process.env.SESSION_CLEANUP_DELAY_MINUTES, 5),

  /** Idle reaper TTL (ms). MCP transport sessions whose `lastActivity` is older
   * than this get torn down by the periodic reaper, decrementing the
   * `mcp.sessions.by_client` gauge. Default 10 min — long enough that normal
   * idle pauses between tool calls in a conversation don't trigger reaping,
   * short enough that abandoned sessions clear within the lifetime of a
   * typical user session. 0 disables the reaper entirely. */
  mcpIdleReapMs: intOr(process.env.MCP_IDLE_REAP_MS, 10 * 60 * 1000),
  /** Reaper sweep interval (ms). Smaller = more responsive, larger = cheaper.
   * Default 60s. Must be > 0 when reaper enabled. */
  mcpIdleReapIntervalMs: intOr(process.env.MCP_IDLE_REAP_INTERVAL_MS, 60_000),

  /** Phase X — per-file cap for `/my/upload` (bytes). Default 50 MB. */
  uploadFileMaxBytes: intOr(process.env.UPLOAD_FILE_MAX_BYTES, 50 * 1024 * 1024),
  /** Phase X — per-user pending uploads quota (bytes). Sum of currently-pending,
   * unexpired rows. Default 100 MB (room for 2 max-size files in flight). */
  uploadQuotaBytes: intOr(process.env.UPLOAD_QUOTA_BYTES, 100 * 1024 * 1024),
  /** Phase X — TTL on a pending upload before TTL purge eats it. Default 15 min. */
  uploadTtlSeconds: intOr(process.env.UPLOAD_TTL_SECONDS, 15 * 60),

  /** OAuth IP rate-limit: max requests per window per IP. 0 disables. */
  oauthRateLimit: intOr(process.env.OAUTH_RATE_LIMIT, 30),
  /** OAuth IP rate-limit window in milliseconds. */
  oauthRateWindowMs: intOr(process.env.OAUTH_RATE_WINDOW_MS, 60_000),

  /** Telegram Bot API token for in-product broadcasts (Phase 0.1). Empty disables bot routes. */
  botToken: optional(process.env.BOT_TOKEN, ""),
  /** Bot username (without @) for deep-link CTA on landing. */
  botUsername: optional(process.env.BOT_USERNAME, "").replace(/^@/, ""),
  /** Random secret in webhook URL path — Telegram echoes only to /bot/webhook/<secret>. */
  botWebhookSecret: optional(process.env.BOT_WEBHOOK_SECRET, ""),

  /** Shared secret SigNoz sends in `X-Webhook-Secret` to `/api/alerts/signoz`.
   * Empty disables the alert-bridge route entirely. */
  alertWebhookSecret: optional(process.env.ALERT_WEBHOOK_SECRET, ""),
  /** Numeric Telegram chat that receives forwarded SigNoz alerts. 0 disables. */
  alertChatId: intOr(process.env.ALERT_CHAT_ID, 0),
};

export const iconUrl = `${config.issuer}/icon.svg`;
export const iconPngUrl = `${config.issuer}/icon.png`;
export const iconPng256Url = `${config.issuer}/icon-256.png`;
