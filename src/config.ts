const required = (name: string, value: string | undefined): string => {
  if (!value?.trim()) {
    throw new Error(`Required env var ${name} is missing. See .env.example.`);
  }
  return value;
};

const optional = (value: string | undefined, fallback: string): string => value?.trim() || fallback;

/** Parse env int preserving 0 as valid. Replaces with fallback only on undefined/empty/NaN. */
const intOr = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  // Fallback kept until migration to mcp-telegram-infra with explicit ENV (Phase 5.2).
  // After migration — replace with "http://localhost:3000".
  issuer: optional(process.env.ISSUER, "https://mcp-telegram.com"),
  port: intOr(process.env.PORT, 3000),
  brandName: optional(process.env.BRAND_NAME, "MCP Telegram"),
  contactEmail: optional(process.env.CONTACT_EMAIL, ""),
  /** Telegram handle without leading @ (stripped once at load). */
  contactTelegram: optional(process.env.CONTACT_TELEGRAM, "").replace(/^@/, ""),

  openaiAppsChallenge: optional(process.env.OPENAI_APPS_CHALLENGE, ""),
  adminToken: process.env.ADMIN_TOKEN ?? "",

  telegramApiId: Number(required("TELEGRAM_API_ID", process.env.TELEGRAM_API_ID)),
  telegramApiHash: required("TELEGRAM_API_HASH", process.env.TELEGRAM_API_HASH),

  signozEndpoint: optional(process.env.SIGNOZ_ENDPOINT, ""),
  logServiceName: optional(process.env.LOG_SERVICE_NAME, "mcp-telegram-cloud"),
  logUserIds: process.env.LOG_USER_IDS !== "false",
  /** HMAC key for hashing user IDs in logs (prevents rainbow-table lookup). */
  logHashSalt: optional(process.env.LOG_HASH_SALT, "mcp-telegram-default-salt-rotate-me"),

  databasePath: optional(process.env.DATABASE_PATH, "./data/cloud.db"),
  /** 0 = keep forever (no retention purge). */
  usageLogRetentionDays: intOr(process.env.USAGE_LOG_RETENTION_DAYS, 90),

  /** 0 = unlimited (rate-limit check effectively disabled). */
  freeTierLimit: intOr(process.env.FREE_TIER_LIMIT, 100),
  sessionCleanupDelayMinutes: intOr(process.env.SESSION_CLEANUP_DELAY_MINUTES, 5),
};

export const iconUrl = `${config.issuer}/icon.svg`;
