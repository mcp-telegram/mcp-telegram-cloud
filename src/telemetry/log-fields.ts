/**
 * Compile-time whitelist of attribute keys allowed in structured log records.
 *
 * Why: the runtime PII guard (`scripts/check-telemetry.ts`) catches
 * blacklisted KNOWN-bad keys (`userId`, `peer`, `messageText`, …) but cannot
 * stop a new caller from inventing a fresh PII-shaped key — the grep check
 * only sees what's already on the deny list. This whitelist inverts the
 * problem: anything not explicitly allowed here is a TypeScript error at the
 * call site, so PII categories that haven't been blacklisted yet still get
 * blocked at the boundary.
 *
 * Pair with the runtime grep check, not replace it: the grep check still
 * blocks blacklisted keys behind `// telemetry-allow` escape hatches and
 * inside `recordError` calls that may bypass this type (none today, but the
 * runtime guard is the safety net).
 *
 * Adding a key: append below in the matching category (or open a new one),
 * and prefer narrow string-literal unions (e.g. `outcome`, `signal`) over
 * `string` where the value space is enum-like — this catches typos.
 */

/**
 * Defense-in-depth cap on stringified attribute values at the logger boundary.
 * Applies symmetrically to OTLP export (`src/logger.ts`) and the in-memory
 * error ring (`src/telemetry/error-buffer.ts`). Single source of truth so
 * the two paths cannot drift.
 *
 * Why 256: every legitimate structured attribute value we log fits well
 * inside this; longer payloads (stack traces, full update bodies) belong
 * in the message body, not in attributes.
 */
export const MAX_ATTR_VALUE_LEN = 256;

export type LogFields = Partial<{
  // ── Categorical / enum-like ───────────────────────────────────────────
  /** Subsystem owning the event — short, low-cardinality. */
  component: string;
  /** Dotted event name, e.g. `oauth.token.refresh`. */
  event: string;
  /** Cause label, e.g. rate-limit reason or denial reason. */
  reason: string;
  /** Logical scope name (e.g. rate-limit scope key, NOT raw user input). */
  scope: string;
  /** Source channel, e.g. how a bot subscriber arrived. */
  source: string;
  /**
   * Raw OAuth `client_name` (RFC 7591) — caller-controlled string from
   * dynamic registration. Logged for tool-call breakdown so the
   * `/api/observability` "by client" widget can attribute usage to a
   * registered MCP client. NOT a user @-handle, NOT user PII.
   */
  client: string;
  /**
   * Coarse user-agent class for HTTP access logs:
   * `chatgpt|claude|browser|bot|script|other|empty`. Distinct from `client`
   * because the value space is bounded; HTTP layer cannot see the OAuth
   * `client_name` (only the MCP layer can after token validation).
   */
  clientClass: string;
  /**
   * Public handle (e.g. `@mcp_telegram_cloud_bot`). The runtime grep guard
   * still flags `username:` if it isn't accompanied by a `// telemetry-allow`
   * comment, so the only sanctioned use is logging a published bot/operator
   * handle — never a Telegram user's @username.
   */
  username: string;

  // ── Internal identifiers (safe — not user PII) ────────────────────────
  /** Hashed user id — MUST come from `logUser(...)`. */
  userId: string;
  /** MCP session id (random uuid, server-generated). */
  sessionId: string;
  /** Upload id (server-generated random). */
  uploadId: string;
  /** Tool name (e.g. `send-message`). */
  tool: string;
  /** OAuth client_id (public token, not user PII). */
  clientId: string;
  /**
   * OAuth refresh-token chain id — opaque random hex per auth-code exchange.
   * Used by the rotation/replay detector for forensics ("show me everything in this chain").
   * Server-generated, not derived from user input. Not PII.
   */
  chainId: string;
  /**
   * SHA-256 truncated to 16 hex chars of an OAuth refresh_token. Irreversible group key for
   * correlating multiple replay events on the same token without leaking the secret.
   */
  tokenFingerprint: string;
  /**
   * Whether a replayed refresh_token was a mid-chain link (1) or a freshly created leaf (0).
   * Helps SecOps distinguish "leaked-and-stored" attacks from "truncated-response retry".
   */
  wasMidChain: number;
  /** Count of refresh tokens revoked in a chain-revoke operation. */
  refreshRevoked: number;
  /** Count of access tokens revoked in a chain-revoke operation. */
  accessRevoked: number;
  /** Age in seconds since a refresh-token row was first revoked (used by replay detector). */
  ageSeconds: number;
  /** Issuer URL from server config. */
  issuer: string;
  /** Environment-variable name (e.g. `MCP_TELEGRAM_ENABLE_STARS`). */
  env: string;
  /** HTTP request path template (no query string, no PII). */
  path: string;
  /** Templated route (path with `:param` placeholders, low-cardinality). */
  route: string;
  /** HTTP method (`GET`/`POST`/...). */
  method: string;
  /** HTTP status code as string (`200`/`404`/...). */
  status: string;
  /**
   * Bounded HTTP status class (`2xx`/`3xx`/`4xx`/`5xx`). Mirrors the
   * `status_class` label on the `http.requests` counter so logs- and
   * metrics-based dashboard queries share one bucketing scheme. Keeps
   * SigNoz filters numeric-free (the `status` field is `string` and would
   * need `LIKE '5%'` otherwise).
   */
  status_class: string;
  /**
   * Truncated diagnostic blob from the upstream rate-limiter
   * (`flood_wait` / `network_retry` / `temporary_retry` + method name).
   * Caller SHOULD cap to ≤200 chars to stay below the `MAX_ATTR_VALUE_LEN`
   * (256-byte) boundary truncation; the logger applies the cap regardless.
   */
  context: string;
  /** MIME type of an upload. */
  mime: string;
  /**
   * Free-form error message from `Error.message`. Note: MTProto error
   * formatters may include raw upstream identifiers (e.g.
   * `PEER_ID_INVALID for 12345`). The logger boundary caps the value to
   * 256 chars to bound the leakage shape; sensitive call sites should
   * pre-sanitize before passing to `error:`.
   */
  error: string;

  // ── Numeric metrics ───────────────────────────────────────────────────
  /** Generic counter (e.g. broadcast recipients, rate-limit count). */
  count: number;
  /** Items removed by a purge tick. */
  removed: number;
  /** Items pruned (subscribers, etc.). */
  pruned: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Generic millisecond delay. */
  delayMs: number;
  /** Time since last activity (ms). Used by the idle MCP-session reaper. */
  idleMs: number;
  /** Generic seconds delay. */
  seconds: number;
  /** Bytes uploaded / file size. */
  size: number;
  /** Length of a payload (recipients list, message text). */
  length: number;
  /** Number of recipients. */
  recipients: number;
  /** Successful sends. */
  sent: number;
  /** Failed sends. */
  failed: number;
  /** Active session count. */
  active: number;
  /** Remaining items / sessions / quota after a mutation. */
  remaining: number;
  /** Retry-After header (seconds). */
  retryAfter: number;
  /** Retry attempt index. */
  attempt: number;
  /** Configured max retries. */
  maxRetries: number;
  /** Tier / route limit. */
  limit: number;
  /** Boolean rendered as 0/1. */
  enabled: number;
  /** Retention window in days. */
  retentionDays: number;
}>;
