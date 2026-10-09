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
│   ├─ /oauth/authorize        AuthorizePage with embedded QR,         │
│   │                          or ConsentPage for a new destination    │
│   ├─ /oauth/authorize/qr     QR login SSE stream                     │
│   ├─ /oauth/authorize/approve  Explicit consent (POST, same-origin)  │
│   ├─ /oauth/token            Code & refresh-token exchange           │
│   ├─ /oauth/revoke           Access-token revocation (RFC 7009)      │
│   ├─ /login                  Standalone QR login page                │
│   ├─ /mcp                    MCP Streamable HTTP transport  ──┐      │
│   └─ /api/{stats,            Admin endpoints                  │      │
│       import-session}                                         │      │
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
│  │  user_sessions, oauth_*, usage_log                            │   │
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
- Idle workers are released from memory by the MCP-session reaper
  (`MCP_IDLE_REAP_MS`, default 10 min). The persisted `session_string` in
  SQLite stays — the next tool call from any client resurrects the worker
  via `getOrCreateSession` without a forced QR re-login. Full destruction
  (logOut + DELETE) happens only on explicit OAuth revoke or Telegram-side
  session revocation.

There is no horizontal scaling story today — see
[Known limitations](./self-hosting.md#known-limitations).

## Private media snapshots

`telegram-download-media` prepares bounded, owner-private snapshots in
`DownloadStore` (process RAM only). Agents read retryable 64 KiB chunks through
MCP; people download attachments from `/my/download/:id` using the authenticated
browser session. The URL is not an authorization capability. Every read checks
ownership, source-account attachment and a fixed 15-minute expiry. Snapshots are
not written to SQLite or disk, and restart/rolling replacement invalidates them.
See [downloads.md](./downloads.md) for the complete flow, limits, threat model,
recovery and core-before-cloud release dependency.

## Request lifecycles

### First-time connect (Claude.ai)

```
Claude.ai  ──[1] /.well-known/oauth-authorization-server──────▶ cloud
Claude.ai  ──[2] POST /oauth/register (RFC 7591)──────────────▶ cloud  ─▶ oauth_clients
Claude.ai  ──[3] redirect user → /oauth/authorize?…(PKCE)─────▶ browser
browser    ──[4] GET /oauth/authorize  (no tg_sid session)─────▶ cloud
                                            cloud renders AuthorizePage (HTML)
browser    ──[5] EventSource → /oauth/authorize/qr (SSE)──────▶ cloud
                                            cloud  ──[MTProto qrCode]──▶  Telegram
                                            cloud  ◀──────────────────  user_id, session_string
                                            cloud  ─▶ user_sessions
cloud      ──[6] SSE `redirect` event {url, name, username, id, handoff}─▶ browser
browser    ──[7] POST /oauth/authorize/qr/cookie {handoff} ──▶ cloud  (best-effort;
                trades the single-use ticket for the HttpOnly tg_sid session
                cookie; failures ignored — the redirect still happens)
browser    ──[8] window.location.href = url      ──▶ Claude.ai (carrying ?code=… &state=…)
Claude.ai  ──[9] POST /oauth/token (code + PKCE verifier)──▶ cloud  ─▶ oauth_tokens
Claude.ai  ──[10] /mcp with Bearer token  (initialize)─────▶ cloud
```

After step 10, every tool call is `Authorization: Bearer …` →
`SessionManager.getOrCreateSession(userId)` → MCP request dispatched.

**Reconnect fast path:** if a returning user hits `/oauth/authorize`
with a valid `tg_sid` browser session, the upstream session is still alive, **and
the account has already connected this callback destination**, the cloud
skips QR entirely and 302-redirects straight back to the client with a
fresh code (see `tryReconnectSession()` in
[`src/routes/oauth.tsx`](../src/routes/oauth.tsx)).

That last condition is load-bearing (added v2.60.3). Without it the cookie
alone was enough: registration is open (RFC 7591), so anyone could register a
client pointing at their own `redirect_uri`, and because `tg_user` is
`SameSite=Lax` it rides along on an ordinary top-level link click — one click
handed a stranger a working authorization code for the victim's Telegram. PKCE
does not help there (the attacker picks the verifier) and neither does
`redirect_uri` validation (they registered it). Verified against production
before the fix.

Grants live in `oauth_grants`, keyed by the **origin of the redirect URI**, not
by `client_id`: real clients re-register constantly (one production snapshot
held 727 `Claude` client rows pointing at the same callback), so a per-client
record would expire on every reconnect and put a confirmation screen in front
of every returning user. A destination the user has no grant for renders
`ConsentPage` instead, showing the destination HOST — `client_name` is
attacker-chosen at registration and can say "Claude", the host cannot be
faked. Approving POSTs to `/oauth/authorize/approve` (Origin-checked, and the
`SameSite=Lax` cookie is not attached to a cross-site POST at all).

Users who already held a token for a destination are grandfathered by
`OAuthProvider.hasGrant()`, so the change was invisible to everyone connected
at the time it shipped.

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
| `oauth_grants` | Callback destinations the user has knowingly connected | PK `(user_id, redirect_origin)`; gates the silent authorize fast path |
| `usage_log` | Per-call counter for quotas + analytics | Purged daily by retention |

Cleanup tasks run on `setInterval`:

- OAuth code/token purge — every 1h.
- `usage_log` purge — every 24h, gated by `USAGE_LOG_RETENTION_DAYS > 0`.

## Authentication & authorization

### User auth (per-user MTProto)

QR login over SSE. The user scans on their phone; Telegram returns the
session string straight to the cloud, which stores it under the identity
reported by `getMe()` for the account that actually signed in \u2014 never under an
id supplied by the caller. (`/login/qr?userId=` no longer affects identity at all. Until v2.60.3 it was also used as
the STORAGE key, and since `user_sessions` upserts on conflict, anyone could
pass a victim's handle, scan with their own phone and overwrite that victim's
session row \u2014 after which the victim's still-valid tokens drove the attacker's
account.) The browser only ever sees a
`tg_sid` cookie (HttpOnly + Secure + SameSite=Lax, 30 days; a year when
started by a review link, so it cannot expire mid-review): an opaque
256-bit token that maps to a row in `browser_sessions` (stored as a hash).
The row is created only after proof of identity: a finished QR scan,
handed to the page as a single-use two-minute ticket, or a valid review
token. Until v2.61.0 the cookie was `tg_user=<username>` and the server
trusted it, so anyone who knew a username could act as that user; the old
cookie is now ignored and cleared. `/login/qr` always requires a scan.

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
- Access token TTL is **10 years** (`ACCESS_TOKEN_TTL_SECONDS`), not one
  hour: some MCP clients do not persist the refresh token reliably, and a
  short access TTL turned into "re-authenticate every hour" for them. The
  trade-off is deliberate but real — a leaked access token stays valid until
  it is revoked by hand.

**Revocation is not just a token operation.** `POST /oauth/revoke` also calls
`destroyUserSession()`: the Telegram session is logged out and deleted, so the
user must scan a new QR code, and *every* client of theirs loses access, not
only the one whose token was revoked. (Revoking also drops the user's
`oauth_grants` rows only if the account is deleted — an ordinary revoke leaves
them, so reconnecting the same client does not ask for confirmation again.) That is the documented product behaviour
("remove the connector → your session is deleted immediately"), but it means
revoke must never be used as a cleanup step after testing.

The cloud **does not** support implicit grant or password grant.

### Review access links

`/review?token=…` redeems a link that points at a prepared demo account. It
starts the same `tg_sid` browser session a QR scan starts and then steps aside — the
ordinary OAuth fast path issues the code, so there is no second authentication
path to audit. Since v2.60.3 that fast path also requires a grant for the
callback destination: the demo account already holds tokens for
`https://chatgpt.com`, so directory reviewers are grandfathered, but a link
pointing at a brand-new destination shows the consent screen once. Tokens are 192-bit, stored as a SHA-256 hash, reusable (a
reviewer returns more than once), revocable by id, and rate-limited at the
endpoint. Issuing requires `ADMIN_TOKEN`. See
[configuration.md](configuration.md) for the operator commands.

### Tool annotations

Every tool carries MCP hints that clients use to decide what needs a user
confirmation, so they are classified from behaviour rather than from how risky
they feel. Two questions decide the class — can the user undo it
(`destructiveHint`), and can anyone but the account owner see it
(`openWorldHint`):

| Class | `readOnly` | `destructive` | `openWorld` | Examples |
| --- | --- | --- | --- | --- |
| `READ_ONLY` | ✔ | ✘ | ✘ | read, search, download |
| `LOCAL_WRITE` | ✘ | ✘ | ✘ | read markers, drafts, folders, mute, privacy |
| `OUTBOUND_WRITE` | ✘ | ✘ | ✔ | send/forward, reactions, invites, profile |
| `CONFIRMED_WRITE_LOCAL` | ✘ | ✔ | ✘ | replace a folder's chats, story stealth mode |
| `CONFIRMED_WRITE_PUBLIC` | ✘ | ✔ | ✔ | edit a sent message, edit group info, business hours/location/intro, inline bot result |
| `DESTRUCTIVE_LOCAL` | ✘ | ✔ | ✘ | clear drafts, delete folder, detach account |
| `DESTRUCTIVE_PUBLIC` | ✘ | ✔ | ✔ | delete message, ban, kick, revoke link, report |

"Open world" is not "calls an external API" — everything here goes through
Telegram, so that reading would mark all tools false and say nothing. It is
whether the effect leaves this account.

The `DESTRUCTIVE_*` tools (deletions, bans, reports) are gated by
`DestructiveGuard`: off by default, per-user opt-in at `/my/settings`, its own
daily quota, and an audit row for each attempt readable at `/my/audit`.
`CONFIRMED_WRITE_*` tools also carry `destructiveHint: true`, because the old
value is gone after the change and the host should confirm first, but they are
not behind the opt-in: nothing is deleted and the user can set the value again.
`isGuardedDestructive()` in `src/tools/helpers.ts` draws that line.

`src/__tests__/tool-annotation-contract.test.ts` pins the class of every tool
and fails when a new one is added without a decision.

### Admin auth

`/api/stats` accepts `Authorization: Bearer $ADMIN_TOKEN` only —
compared with `crypto.timingSafeEqual()`.
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
  cookie-handler.ts       tg_sid browser session cookie + QR handoff decision
  qr-login.ts             SSE handler for QR auth
  rate-limit.ts           per-IP token-bucket middleware
  rate-limiter-events*.ts forward upstream stderr events to logger
  usage.ts                quota + retention purge
  mcp-handler.ts          MCP request dispatch, tool filter
  tools.ts                tool whitelist (cloud subset of upstream)
  icon.ts                 inline SVG icon served at /icon.svg
  styles.ts               shared design tokens for landing pages
  auth/admin.ts           bearer-token check for /api/*
  middleware/access-log.ts HTTP request log
  pages/                  Hono JSX components (landing, privacy, ...)
  routes/                 Hono route modules (admin, mcp, …)
```
