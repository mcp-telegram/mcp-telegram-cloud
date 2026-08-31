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
const parseHttpUrl = (name: string, value: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Env var ${name} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Env var ${name} must be an http(s) URL, got protocol "${parsed.protocol}".`);
  }
  return parsed;
};

export const httpUrl = (name: string, value: string): string => {
  parseHttpUrl(name, value);
  return value;
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
 * - `local-only` (default): writes SQLite usage_log + console logs + in-memory snapshots for /api/observability. **Zero outbound** to SigNoz.
 * - `on`: same as local-only PLUS OTLP HTTP exporter to SigNoz (logs, metrics, traces — all three signals share the same gate).
 * - `off`: suppresses everything except SQLite usage_log (truly silent — no console, no OTLP, no in-memory egress).
 *
 * Read dynamically by `logger.ts:otlpActive`/`consoleActive`, `metrics.ts:otlpActive`,
 * `tracer.ts:otlpActive` — not snapshotted at module load, so changing the env (or
 * mutating `config.telemetryMode` in tests) takes effect on the next flush/log call. */
export type TelemetryMode = "on" | "off" | "local-only";
/** Exported for unit tests; not for runtime use outside config.ts. */
export const parseTelemetryMode = (raw: string | undefined): TelemetryMode => {
  const v = raw?.trim().toLowerCase();
  if (v === "on" || v === "off" || v === "local-only") return v;
  return "local-only";
};

/**
 * ISSUER is the most load-bearing URL in the process: OAuth issuer, base for
 * every absolute link, the `resource` identifier advertised to MCP clients, and
 * the value embedded in the `WWW-Authenticate` header of a 401. It used to be
 * the ONLY url-shaped env var that skipped {@link httpUrl}, so `ISSUER=not-a-url`
 * booted fine and produced broken discovery metadata at runtime instead.
 *
 * It must be a bare ORIGIN, and that is enforced rather than assumed. The whole
 * codebase already treats it as one — every route is mounted at `/`, the RFC 8414
 * and RFC 9728 documents are served from the root well-known paths, and
 * `routes/my.tsx` compares `new URL(origin).origin === config.issuer` — so a
 * path-bearing `https://host/base` silently half-works: some URLs would be built
 * with the prefix, others without, and the same-origin check would reject valid
 * requests. Failing at boot is the only honest outcome.
 *
 * Checks, and why each exists:
 *  - raw quote/backslash/whitespace: the value is emitted inside the quoted
 *    `resource_metadata="..."` parameter of WWW-Authenticate. Inspecting the
 *    PARSED host is not enough — `https://ho\st.example` parses to host `ho`
 *    with the rest pushed into the path, so the check would pass while the
 *    effective issuer silently differs from what the operator configured.
 *  - userinfo: `https://user:pass@host` would be republished as discovery — trufflehog:ignore
 *    metadata, leaking the credentials to every client that fetches it. The
 *    example above is a rejected input, not a credential.
 *  - path/query/fragment: see above — not an origin.
 */
export const issuerUrl = (name: string, value: string): string => {
  // Control characters are tested by code point rather than as a regex range:
  // a literal control char inside a regex literal is itself a lint error, and
  // spelling the bound out is clearer than an escaped range anyway.
  const hasControlChar = Array.from(value).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (/["\\\s]/.test(value) || hasControlChar) {
    throw new Error(`Env var ${name} must not contain quotes, backslashes, whitespace or control characters.`);
  }
  const normalized = value.replace(/\/+$/, "");
  const parsed = parseHttpUrl(name, normalized);
  if (parsed.username || parsed.password) {
    throw new Error(`Env var ${name} must not contain userinfo (user:pass@) — it is published in OAuth metadata.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      `Env var ${name} must be a bare origin (scheme://host[:port]) with no path, query or fragment, got: ${normalized}`,
    );
  }
  // Returns the operator's spelling (minus trailing slashes), NOT `parsed.origin`.
  // RFC 8414 §2 compares issuer identifiers by exact string, and `URL.origin`
  // would silently rewrite one: lowercasing the host, punycoding an IDN, and
  // dropping an explicit :443/:80. A self-hoster configured as
  // `https://MyHost.com:443` would then publish a different issuer than the one
  // their clients already cached. Validation is the job here; canonicalisation
  // is not ours to impose. URL building goes through `rootUrl`, which does
  // normalise — safe, because that produces a URL, not an identifier.
  return normalized;
};

export const config = {
  /** Public origin (scheme + host, no trailing slash) — used in OAuth metadata
   * and absolute URLs in the landing/OAuth pages. */
  issuer: issuerUrl("ISSUER", required("ISSUER", process.env.ISSUER)),
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

  /** 32-byte key (64 hex or 44-char base64) that encrypts `session_string` at rest in
   * cloud.db. Injected from a GitHub Secret at deploy time → held only in RAM, never on
   * disk, so a stolen volume/backup yields ciphertext without the key. Empty = PASSTHROUGH
   * (self-host/dev/OSS store plaintext + a startup warning). See {@link ./crypto.ts}. */
  sessionEncryptionKey: optional(process.env.SESSION_ENCRYPTION_KEY, ""),

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

  /**
   * Dynamic client registration (RFC 7591) is unauthenticated, so it gets a
   * much stricter per-IP cap than the general OAuth limit — real clients
   * register once. Default 5 per hour per IP. 0 disables. (Audit H2.)
   */
  registerRateLimit: intOr(process.env.REGISTER_RATE_LIMIT, 5),
  registerRateWindowMs: intOr(process.env.REGISTER_RATE_WINDOW_MS, 60 * 60_000),
  /** Hard ceiling on total oauth_clients rows; registration past this is rejected. 0 disables. */
  maxOauthClients: intOr(process.env.MAX_OAUTH_CLIENTS, 5000),
  /** Prune oauth_clients with zero successful authorizations older than N days. 0 disables. */
  unusedClientTtlDays: intOr(process.env.UNUSED_CLIENT_TTL_DAYS, 30),

  /** Per-token rate-limit on /mcp: max requests per window per Bearer token. 0 disables. */
  mcpRateLimit: intOr(process.env.MCP_RATE_LIMIT, 240),
  mcpRateWindowMs: intOr(process.env.MCP_RATE_WINDOW_MS, 60_000),

  /** Max request body bytes for JSON API routes (/oauth/*, /mcp). Default 1 MiB. */
  maxJsonBodyBytes: intOr(process.env.MAX_JSON_BODY_BYTES, 1024 * 1024),
};

export const iconUrl = `${config.issuer}/icon.svg`;
export const iconPngUrl = `${config.issuer}/icon.png`;
export const iconPng256Url = `${config.issuer}/icon-256.png`;
