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

- **Streamable HTTP transport** — the core ships stdio only.
- **OAuth 2.0** with dynamic client registration so Claude.ai and
  ChatGPT can connect without a manual API key.
- **Multi-user session store** in SQLite.
- **Per-user usage quotas** and per-IP OAuth rate limiting.
- **Landing / privacy / terms pages** for a public-facing deploy.

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Claude.ai / ChatGPT                         │
│              (MCP client, OAuth 2.0 + Streamable HTTP)               │
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
│   ├─ /                       LandingPage.tsx + privacy/terms         │
│   ├─ /.well-known/oauth-*    Discovery (RFC 8414, RFC 9728)          │
│   ├─ /oauth/register         Dynamic client reg (RFC 7591)           │
│   ├─ /oauth/authorize        AuthorizePage with embedded QR          │
│   ├─ /oauth/authorize/qr     QR login SSE stream                     │
│   ├─ /oauth/token            Code & refresh-token exchange           │
│   ├─ /oauth/revoke           Access-token revocation (RFC 7009)      │
│   ├─ /login                  Standalone QR login page                │
│   ├─ /mcp                    MCP Streamable HTTP transport  ──┐      │
│   ├─ /api/{stats,broadcast,  Admin endpoints                  │      │
│   │   import-session}                                         │      │
│   └─ /bot/webhook/<secret>   Telegram bot updates             │      │
│                                                               │      │
│  ┌────────────────────────────────────────────────────────────▼──┐   │
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
Claude.ai  ──[1] /.well-known/oauth-authorization-server──────▶ cloud
Claude.ai  ──[2] POST /oauth/register (RFC 7591)──────────────▶ cloud  ─▶ oauth_clients
Claude.ai  ──[3] redirect user → /oauth/authorize?…(PKCE)─────▶ browser
browser    ──[4] GET /oauth/authorize  (no tg_user cookie)────▶ cloud
                                            cloud renders AuthorizePage (HTML)
browser    ──[5] EventSource → /oauth/authorize/qr (SSE)──────▶ cloud
                                            cloud  ──[MTProto qrCode]──▶  Telegram
                                            cloud  ◀──────────────────  user_id, session_string
                                            cloud  ─▶ user_sessions
cloud      ──[6] SSE `redirect` event {url, name, username, id}─▶ browser
browser    ──[7] POST /oauth/authorize/qr/cookie ──▶ cloud  (best-effort, only
                if username is known; sets HttpOnly tg_user cookie; failures
                ignored — the redirect still happens)
browser    ──[8] window.location.href = url      ──▶ Claude.ai (carrying ?code=… &state=…)
Claude.ai  ──[9] POST /oauth/token (code + PKCE verifier)──▶ cloud  ─▶ oauth_tokens
Claude.ai  ──[10] /mcp with Bearer token  (initialize)─────▶ cloud
```

After step 10, every tool call is `Authorization: Bearer …` →
`SessionManager.getOrCreateSession(userId)` → MCP request dispatched.

**Reconnect fast path:** if a returning user hits `/oauth/authorize`
with a valid `tg_user` cookie and the upstream session is still alive,
the cloud skips QR entirely and 302-redirects straight back to the
client with a fresh code (see `tryReconnectSession()` in
[`src/routes/oauth.tsx`](../src/routes/oauth.tsx)).

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
30-day `tg_user` cookie (HttpOnly + Secure + SameSite=Lax) containing
the public Telegram `username` — used as a hint to skip the QR step on
subsequent OAuth flows. The cookie never carries the session string or
the numeric user id, and is only set when the account has a public
username (sentinel `unknown` is rejected to avoid mis-routing future
logins).

### Client auth (LLM ↔ cloud)

Standard OAuth 2.0:

- Dynamic client registration — RFC 7591.
- Authorization code + PKCE S256 — RFC 7636.
- Authorization server metadata — RFC 8414.
- Protected-resource metadata — RFC 9728.
- Token revocation — RFC 7009. **Scope:** access tokens only. A
  refresh token POSTed directly to `/oauth/revoke` is silently treated
  as unknown (RFC 7009 §2.2 allows servers to ignore unsupported token
  types and return 200). Refresh tokens are still cleared
  transitively whenever an associated access token is revoked, via
  `revokeAllUserTokens()`.
- Access token (1h) + refresh token (30d).

The cloud **does not** support implicit grant or password grant.

### Admin auth

`/api/stats` and `/api/broadcast` accept `Authorization: Bearer
$ADMIN_TOKEN` only — compared with `crypto.timingSafeEqual()`.
`/api/import-session` accepts **either** an admin bearer (and then
imports for the `userId` in the request body) **or** a regular user
OAuth bearer (and imports for the token's own user). When
`ADMIN_TOKEN` is unset, the admin path is disabled but the user-bearer
path on `/api/import-session` keeps working. Restrict admin endpoints
at the proxy layer (allow-list IPs, VPN, etc.) — bearer alone is not
sufficient exposure protection.

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
  oauth.ts                OAuth provider core (8414/7591/7636/7009)
  routes/oauth.tsx        OAuth HTTP routes + 9728 well-known
  cookie-handler.ts       tg_user hint cookie (HttpOnly, CSRF guard)
  qr-login.ts             SSE handler for QR auth
  rate-limit.ts           per-IP token-bucket middleware
  rate-limiter-events*.ts forward upstream stderr events to logger
  usage.ts                quota + retention purge
  mcp-handler.ts          MCP request dispatch, tool filter
  tools.ts                tool whitelist (cloud subset of upstream)
  icon.ts                 inline SVG icon served at /icon.svg
  styles.ts               shared design tokens for landing pages
  auth/admin.ts           bearer-token check for /api/*
  bot/                    Telegram bot client + subscriber store
  middleware/access-log.ts HTTP request log
  pages/                  Hono JSX components (landing, privacy, ...)
  routes/                 Hono route modules (admin, bot, mcp, …)
```
