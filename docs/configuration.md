# Configuration Reference

All configuration is via environment variables. The application reads them
once at startup through [`src/config.ts`](../src/config.ts) — there is no
runtime reload. To change a value, set the env and restart.

This document covers **what each variable does and how to choose a value**.
For a copy-pasteable starter, see [`.env.example`](../.env.example).

For the deployment-side hardening checklist (TLS, backups, filesystem
permissions), see [`docs/self-hosting.md`](./self-hosting.md).

## Quick reference

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_API_ID` | ✅ | — | MTProto numeric ID from my.telegram.org |
| `TELEGRAM_API_HASH` | ✅ | — | MTProto hex hash |
| `ISSUER` | ✅ | — | Public origin (no trailing slash) |
| `ADMIN_TOKEN` | ⚠️ | empty | Bearer for `/api/*`. Empty → admin endpoints return 401 |
| `PORT` | | `3000` | HTTP listen port |
| `BRAND_NAME` | | `MCP Telegram` | Display name on landing/MCP metadata |
| `CONTACT_EMAIL` | | empty | Shown on landing/privacy/terms |
| `CONTACT_TELEGRAM` | | empty | Same, Telegram handle (no `@`) |
| `SOURCE_REPO_URL` | | upstream cloud repo | Used in landing/privacy/terms "Open source" links |
| `ISSUES_URL` | | `${SOURCE_REPO_URL}/issues` | Used in privacy/terms "Contact" link |
| `ISSUES_LABEL` | | `GitHub Issues` | Visible text for the issues link |
| `OPENAI_APPS_CHALLENGE` | | empty | ChatGPT Apps Directory challenge token |
| `MCP_TELEGRAM_TELEMETRY` | | `local-only` | Master kill-switch: `local-only` (default, zero outbound) / `on` / `off` |
| `SIGNOZ_ENDPOINT` | | empty | OTLP HTTP endpoint for remote logs + metrics |
| `LOG_SERVICE_NAME` | | `mcp-telegram-cloud` | Service name in OTLP attributes |
| `LOG_USER_IDS` | | `false` | Default hashes user IDs in logs; set `true` only for local debugging |
| `LOG_HASH_SALT` | conditional | empty | Required when `LOG_USER_IDS=false` (which is the default) |
| `DATABASE_PATH` | | `./data/cloud.db` | SQLite file path |
| `USAGE_LOG_RETENTION_DAYS` | | `90` | Daily purge of `usage_log`. `0` = keep forever |
| `FREE_TIER_LIMIT` | | `100` | Per-user daily tool-call quota. `0` = unlimited |
| `SESSION_CLEANUP_DELAY_MINUTES` | | `5` | Idle delay before destroying Telegram session |
| `OAUTH_RATE_LIMIT` | | `30` | Requests per IP per window on `/oauth/*`. `0` disables |
| `OAUTH_RATE_WINDOW_MS` | | `60000` | Window duration in milliseconds |
| `BOT_TOKEN` | | empty | Telegram bot token for broadcasts |
| `BOT_USERNAME` | | empty | Bot handle (no `@`) for landing CTA |
| `BOT_WEBHOOK_SECRET` | | empty | Random secret in webhook URL path |

## Required core

### `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`

Obtained from <https://my.telegram.org/apps>. **MTProto credentials**, not
Bot API. One pair is shared across all users — they only authenticate the
client implementation, not individual accounts.

If invalid, `@overpod/mcp-telegram` will fail at first connection attempt
with `AUTH_KEY_UNREGISTERED`.

### `ISSUER`

Public origin — scheme + host, **no trailing slash**, **no path**.
Examples:

- `https://mcp-telegram.com` ✅
- `https://your-domain.example.com` ✅
- `https://example.com/mcp` ❌ (path not supported)
- `https://example.com/` ❌ (trailing slash — would break OAuth metadata)

**Used for:**

- OAuth issuer in `/.well-known/oauth-authorization-server`
- Redirect URIs allowed during OAuth flow
- Canonical URLs in landing/privacy/terms (SEO `<link rel="canonical">`)
- MCP server icon URL
- Bot webhook URL for `setWebhook` calls

**Changing `ISSUER` after launch invalidates:**

- All issued OAuth access + refresh tokens
- All registered OAuth clients (RFC 7591 dynamic registration)
- Every connected Claude.ai / ChatGPT user has to reconnect

Pick once.

### `ADMIN_TOKEN` (recommended)

Bearer token for the admin endpoints — `/api/stats`,
`/api/import-session`, and (when the broadcast bot is enabled)
`/api/broadcast`. Used with `Authorization: Bearer <token>`.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

When unset/empty, the admin endpoints return `401`. They are gated by
`isAdminAuthorized()` which uses `crypto.timingSafeEqual()`.

> Even with the timing-safe compare, do not expose `/api/*` to the open
> internet. Restrict at the proxy layer (allow-list LAN, VPN, or your
> office IP).

## Server

### `PORT`

Plain integer. The container listens on this port internally; map it from
your reverse proxy. Default `3000`.

### `BRAND_NAME`

Plain string shown on the landing page hero, in `<title>`, and as
`name` in MCP server metadata. Default `MCP Telegram`. Override for
forks (`MyTeam Telegram Connector`).

## Public-facing contact

### `CONTACT_EMAIL`, `CONTACT_TELEGRAM`

Optional. When set, render in the landing footer, privacy policy, and
terms-of-service pages. When empty, the contact blocks are simply not
rendered — the page is still valid, but users have no way to reach you.

`CONTACT_TELEGRAM` should be the handle without `@` — it is normalised
once at load.

For self-hosters: at minimum set one. Even an internal contact (`#ops` in
Slack) is better than nothing for users who hit a bug.

### `SOURCE_REPO_URL`, `ISSUES_URL`, `ISSUES_LABEL`

Public links rendered on the landing page, privacy, and terms.

| Variable | Default | Notes |
| --- | --- | --- |
| `SOURCE_REPO_URL` | `https://github.com/mcp-telegram/mcp-telegram-cloud` | Where users go to read the source. Override if you maintain a fork. Trailing slashes are normalised. |
| `ISSUES_URL` | `${SOURCE_REPO_URL}/issues` | Where users file bugs. Override for GitLab, Jira, mailto:, or a status page. |
| `ISSUES_LABEL` | `GitHub Issues` | Visible link text. Change in lockstep with `ISSUES_URL` so non-GitHub trackers don't ship a misleading label. |

Both URL values pass through a strict `http(s)://` allowlist at startup —
anything else (`javascript:`, `data:`, `file:`, malformed strings) makes
the process refuse to boot. This is deliberate: the URLs are rendered as
anchor `href` on public pages, so a misconfigured operator setting
`javascript:alert(1)` would otherwise create an XSS sink for every
visitor.

## Observability

### `MCP_TELEGRAM_TELEMETRY`

Master kill-switch for outbound observability data. Three modes:

- `local-only` *(default)* — SQLite usage_log, console logs, in-memory
  ring buffer (errors), and in-process counters/histograms/gauges all
  populate. **Zero outbound** to SigNoz. The `/api/observability` admin
  page shows everything live.
- `on` — same as `local-only`, plus OTLP HTTP push of logs **and metrics**
  to `SIGNOZ_ENDPOINT` (no-op if endpoint unset).
- `off` — silent: no console, no OTLP, no ring buffer. SQLite usage_log
  still records (used for fair-use limits).

Defaults are privacy-first by design — operators who run their own SigNoz
explicitly opt in via `MCP_TELEGRAM_TELEMETRY=on`.

### `SIGNOZ_ENDPOINT`

OTLP HTTP endpoint, **no trailing slash**. Example:
`https://your-signoz.example.com:4318`. The same endpoint receives both
`/v1/logs` and `/v1/metrics` (logs flushed every 5s, metrics every 15s).

When empty (or `MCP_TELEGRAM_TELEMETRY` is not `on`), the OTLP exporter is
a no-op — `console.log/info/warn/error` output still appears in container
stdout for `docker logs` / journald. Set this only if you want structured
aggregation across replicas, alert rules, or a dashboard.

### Metrics surfaced

Every metric is gated by `MCP_TELEGRAM_TELEMETRY` and exported to SigNoz
with `service.name=$LOG_SERVICE_NAME`:

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `http.requests` | counter | `route`, `method`, `status_class`, `client` | `route` is template-collapsed — `/bot/webhook/<secret>` → `/bot/webhook/:secret` |
| `http.duration` | histogram (ms) | `route`, `method`, `status_class` | Buckets `5/10/25/50/100/250/500/1000/2500/5000/10000` |
| `mcp.tool.calls` | counter | `tool`, `outcome` | `outcome` ∈ `{ok, error}` |
| `mcp.tool.duration` | histogram (ms) | `tool`, `outcome` | Buckets `50/100/250/500/1000/2500/5000/10000/30000` |
| `oauth.flow` | counter | `step`, `outcome` | `step` ∈ `{register, authorize, token, refresh, revoke}` |
| `rate_limit.hits` | counter | `tier`, `tool` | `tier` ∈ `{free, destructive}` |
| `mcp.sessions.active` | gauge | — | Live MTProto session count in pool |
| `uploads.pending.bytes` | gauge | — | Sum of unexpired pending upload bytes (all users) |

### `LOG_SERVICE_NAME`

Service name attached as the `service.name` resource attribute in OTLP.
Default `mcp-telegram-cloud`. Override only if you run multiple instances
behind one SigNoz and need to distinguish them.

### `LOG_USER_IDS` / `LOG_HASH_SALT`

Telegram user IDs are short numeric values — direct logging makes them
trivially correlatable across log epochs.

- `LOG_USER_IDS=false` *(default)* — log only `u:` + the first 10 hex
  chars of `HMAC-SHA256(salt, userId)`. The cloud-public deployment uses
  this.
- `LOG_USER_IDS=true` — log raw numeric IDs. Acceptable only for
  short-lived local debugging; the daemon **logs a startup warning** when
  this is set in production.

When `LOG_USER_IDS=false` and `LOG_HASH_SALT` is empty (or set to the
sentinel default `mcp-telegram-default-salt-rotate-me`), the
hash provides no protection — anyone with the source can rebuild
the mapping. The application **logs a startup warning** in this case;
treat it as a configuration error.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rotating the salt breaks correlation across log epochs. Rotate during
incident response, not as routine.

## Storage

### `DATABASE_PATH`

SQLite file path. The directory must exist and be writable by the
container user. The published image currently runs as root (no `USER`
directive in the Dockerfile); if you switch to a non-root user via a
custom Dockerfile or `user:` in compose, ensure that UID owns the
volume. Defaults to `./data/cloud.db` — if you mount a host volume at
`/app/data`, the default path is correct.

The DB stores:

- Telegram session strings (plaintext — see [self-hosting threat model](./self-hosting.md#threat-model--read-this-first))
- OAuth clients, access codes, tokens, refresh tokens
- Per-user usage counters
- Bot subscriber list

Single-writer (better-sqlite3). Not horizontally shardable.

### `USAGE_LOG_RETENTION_DAYS`

Daily background purge of rows older than this in `usage_log`. Default
`90` days. Set `0` to disable purge (rows accumulate forever — useful
for offline analytics, dangerous for live deploys).

## Rate limiting

### `FREE_TIER_LIMIT`

Per-user daily quota of MCP tool calls. Default `100`. Set `0` for
unlimited (recommended for self-hosted instances with a closed user
list).

When exceeded, the MCP response returns a structured error with a
self-host CTA pointing at `SOURCE_REPO_URL` — there is no paid tier;
unlimited usage means running the server yourself.

### `SESSION_CLEANUP_DELAY_MINUTES`

After the last MCP client disconnects, the worker keeps the Telegram
session alive for this many minutes before tearing it down. Trade-off:
shorter = lower memory, more reconnect churn; longer = faster reuse,
more idle workers. Default `5`.

### `OAUTH_RATE_LIMIT` / `OAUTH_RATE_WINDOW_MS`

Per-IP token-bucket rate limit on `/oauth/*` (register, authorize, token,
revoke). Default `30 / 60_000` = 30 requests per 60 seconds per IP.

- Tighten for private deploys: `OAUTH_RATE_LIMIT=10`.
- Disable: `OAUTH_RATE_LIMIT=0` — only safe behind another rate limiter
  (Cloudflare, nginx, gateway).

The IP is detected from `X-Real-IP` then `X-Forwarded-For` last hop;
ensure your reverse proxy sets one of these.


## Bot broadcasts (optional)

The Phase 0.1 broadcast bot lets you notify connected users about
incidents and breaking changes via a dedicated Telegram bot.

All three of `BOT_TOKEN`, `BOT_USERNAME`, `BOT_WEBHOOK_SECRET` must be
set together — partial config will throw at startup. When unset, the
bot routes (`/bot/webhook/*`, `/api/broadcast`) are not registered.

### `BOT_TOKEN`

`123456:ABC...` from [@BotFather](https://t.me/BotFather). Create a
dedicated bot — do not reuse a personal one.

### `BOT_USERNAME`

Bot handle without `@`. Used to render the deep-link CTA on the landing
page (`https://t.me/<username>?start=subscribe`).

### `BOT_WEBHOOK_SECRET`

Random secret embedded in the webhook URL path —
`/bot/webhook/<secret>`. Telegram echoes only to this URL, so a leaked
URL = anyone can spoof bot updates.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

After setting, register the webhook:

```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=$ISSUER/bot/webhook/$BOT_WEBHOOK_SECRET"
```

## ChatGPT Apps Directory (optional)

### `OPENAI_APPS_CHALLENGE`

Domain verification token returned at
`/.well-known/openai-apps-challenge`. Obtained when registering the
service in the ChatGPT Apps Directory submission flow.

When empty, the endpoint returns `404` silently. Self-hosters not
submitting to the directory should leave it empty.

## Deprecated / removed

None. If a variable is referenced in old logs or stack files but not in
this table, it is no longer read by the code — safe to remove.
