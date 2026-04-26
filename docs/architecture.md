# Architecture

High-level view of how `mcp-telegram-cloud` is built and where data
flows. For configuration, see [`configuration.md`](./configuration.md);
for hardening, see [`self-hosting.md`](./self-hosting.md).

## What this service is

A multi-user [MCP](https://modelcontextprotocol.io) server that exposes
a Telegram account as tools to LLM clients (Claude.ai, ChatGPT). Each
user authenticates **once via QR scan**; the server keeps an MTProto
session and proxies tool calls.

It is a thin shell around the open-source
[`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram)
core. The cloud project adds:

- **HTTP / SSE transport** — the core ships stdio only.
- **OAuth 2.0** with dynamic client registration so Claude.ai and
  ChatGPT can connect without a manual API key.
- **Multi-user session store** in SQLite.
- **Per-user usage quotas** and per-IP OAuth rate limiting.
- **Landing / privacy / terms pages** for a public-facing deploy.

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Claude.ai / ChatGPT                         │
│                  (MCP client, OAuth 2.0 + SSE)                       │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTPS
                               ▼
                    ┌──────────────────────┐
                    │  Reverse proxy / TLS │  (Traefik, nginx, Caddy)
                    └──────────┬───────────┘
                               │ HTTP (private network)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       mcp-telegram-cloud                             │
│                                                                      │
│  Hono app (src/server.tsx)                                           │
│   ├─ /                       LandingPage.tsx                         │
│   ├─ /login                  QR login (SSE)                          │
│   ├─ /authorize, /token …   OAuth provider (RFC 8414/7591/7636)      │
│   ├─ /mcp                    MCP HTTP+SSE handler  ─┐                │
│   ├─ /api/stats, /broadcast  Admin endpoints        │                │
│   └─ /bot/webhook/<secret>   Telegram bot updates   │                │
│                                                     │                │
│  ┌──────────────────────────────────────────────────▼────────────┐   │
│  │                       SessionManager                          │   │
│  │  Map<userId → TelegramService>  (in-memory, idle TTL)         │   │
│  └────────────────────────────────┬──────────────────────────────┘   │
│                                   │                                  │
│  ┌────────────────────────────────▼──────────────────────────────┐   │
│  │             @overpod/mcp-telegram (TelegramService)           │   │
│  │  Wraps GramJS.  IPC daemon spawns one worker per user.        │   │
│  │  Master process owns the Map; workers own MTProto sockets.    │   │
│  └────────────────────────────────┬──────────────────────────────┘   │
│                                   │                                  │
│  ┌────────────────────────────────▼──────────────────────────────┐   │
│  │                  better-sqlite3 (./data/cloud.db)             │   │
│  │  user_sessions, oauth_*, usage_log, bot_subscribers           │   │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ MTProto over TCP/443
                                   ▼
                       ┌──────────────────────┐
                       │    Telegram DCs      │
                       └──────────────────────┘
```

## Process model

Single Node.js process. Inside it:

- The **master** runs Hono, owns the SQLite handle, owns the
  `SessionManager` map.
- For each connected user, `@overpod/mcp-telegram` spawns a **worker
  child process** holding the MTProto socket. The master talks to it via
  IPC. This isolates GramJS event loops from the HTTP server and lets
  one stuck Telegram call not block other users.
- Idle workers are torn down `SESSION_CLEANUP_DELAY_MINUTES` after the
  last MCP client disconnects.

There is no horizontal scaling story today — see
[Known limitations](./self-hosting.md#known-limitations).

## Request lifecycles

### First-time connect (Claude.ai)

```
Claude.ai  ──[1] /.well-known/oauth-authorization-server──▶  cloud
Claude.ai  ──[2] POST /oauth/register (RFC 7591)─────────▶  cloud      ─▶  oauth_clients
Claude.ai  ──[3] redirect user to /authorize?…──────────▶  browser
browser    ──[4] GET /authorize (no cookie)────────────────▶  cloud  ──▶  /login (QR)
browser    ──[5] SSE: receives QR payload, user scans──────▶  cloud
                                                              cloud  ──[MTProto]──▶  Telegram (qrCode auth)
                                                              cloud  ◀─────────────  user_id, session_string
cloud      ──[6] redirect /authorize?user=…────────────────▶ browser
browser    ──[7] /authorize → emit code, redirect back─────▶ Claude.ai
Claude.ai  ──[8] POST /oauth/token (PKCE verifier)─────────▶ cloud      ─▶  oauth_tokens
Claude.ai  ──[9] /mcp with Bearer token  (initialize)──────▶ cloud
```

After step 9, every tool call is `Authorization: Bearer …` →
`SessionManager.getOrCreateSession(userId)` → MCP request dispatched.

### Subsequent calls (warm worker)

```
Claude.ai  ─── /mcp + Bearer ──▶  cloud
                                  │
                                  ├─ check usage quota (UsageTracker)
                                  ├─ resolve userId from token
                                  ├─ hit existing TelegramService in Map
                                  └─ forward MCP method to worker via IPC
                                                      │
                                                      ▼
                                                  Telegram MTProto
```

### Cold worker (process restart)

`SessionManager.getOrCreateSession(userId)` falls back to SQLite
`user_sessions.session_string`, spawns a new worker, hands it the
session — Telegram does not re-auth.

## Storage layout

All in one SQLite file at `DATABASE_PATH`. Tables:

| Table | Purpose | Notes |
| --- | --- | --- |
| `user_sessions` | `userId → MTProto session string` | **Plaintext.** See threat model. |
| `oauth_clients` | RFC 7591 dynamic registration entries | One row per Claude.ai/ChatGPT install |
| `oauth_codes` | Short-lived authorization codes | TTL 10 min, indexed on `expires_at` |
| `oauth_tokens` | Access tokens (1h) | Indexed on `user_id`, `expires_at` |
| `oauth_refresh_tokens` | Refresh tokens (30d) | Indexed on `user_id`, `expires_at` |
| `usage_log` | Per-call counter for quotas + analytics | Purged daily by retention |
| `bot_subscribers` | Users opted into broadcast bot | One row per Telegram user |

Cleanup tasks run on `setInterval`:

- OAuth code/token purge — every 1h.
- `usage_log` purge — every 24h, gated by `USAGE_LOG_RETENTION_DAYS > 0`.

## Authentication & authorization

### User auth (per-user MTProto)

QR login over SSE. The user scans on their phone; Telegram returns the
session string straight to the cloud. The browser only ever sees a
short-lived `tg_user` cookie containing the public Telegram `username`
(used as a hint to skip the QR step on subsequent OAuth flows) — never
the session string or the numeric user id.

### Client auth (LLM ↔ cloud)

Standard OAuth 2.0:

- Dynamic client registration — RFC 7591.
- Authorization code + PKCE S256 — RFC 7636.
- Server metadata — RFC 8414.
- Access token (1h) + refresh token (30d).

The cloud **does not** support implicit grant or password grant.

### Admin auth

`/api/stats`, `/api/broadcast`, `/api/import-session` accept
`Authorization: Bearer $ADMIN_TOKEN` only. Compared with
`crypto.timingSafeEqual()`. Restrict at the proxy layer (allow-list IPs,
VPN, etc.) — bearer alone is not sufficient exposure protection.

## Observability

Single logger (`src/logger.ts`) with two sinks:

1. `console.*` — always on, captured by `docker logs` / journald.
2. OTLP HTTP exporter — only when `SIGNOZ_ENDPOINT` is set. Batches and
   ships structured logs out-of-band.

User IDs in logs are gated by `LOG_USER_IDS`; when `false`, every
appearance is replaced by `u:` + the first 10 hex chars of
`HMAC-SHA256(LOG_HASH_SALT, userId)` via `logUser()`.

The rate-limiter installer (`installRateLimiterEventListener()`) hooks
`console.error` once at startup and forwards
`[rate-limiter] event {…}` lines emitted by `@overpod/mcp-telegram`
into structured `logger.warn` calls. The original `console.error` is
always called too — composition with other interceptors is preserved.

## External dependencies

- **Telegram DCs** — required, this is what the service exists to
  reach.
- **OTLP collector (SigNoz)** — optional. No-op when unset.
- **Telegram Bot API** — optional. Only used if all three `BOT_*` vars
  are set; otherwise the `/bot/webhook/*` and `/api/broadcast` routes
  are not registered.
- **OAuth identity provider** — none. The cloud is its own OAuth
  authorization server.

## Code map

```
src/
  server.tsx              app bootstrap, route wiring
  config.ts               single source of truth for env
  logger.ts               console + OTLP, logUser() helper
  session-manager.ts      Map<userId, TelegramService>
  oauth.ts                OAuth provider (RFC 8414/7591/7636)
  qr-login.ts             SSE handler for QR auth
  rate-limit.ts           per-IP token-bucket middleware
  rate-limiter-events*.ts forward upstream stderr events to logger
  usage.ts                quota + retention purge
  mcp-handler.ts          MCP request dispatch, tool filter
  tools.ts                tool whitelist (cloud subset of upstream)
  icon.ts                 PNG icon served at /icon.svg
  styles.ts               shared design tokens for landing pages
  auth/admin.ts           bearer-token check for /api/*
  bot/                    Telegram bot client + subscriber store
  middleware/access-log.ts HTTP request log
  pages/                  Hono JSX components (landing, privacy, ...)
  routes/                 Hono route modules (admin, bot, mcp, …)
```
