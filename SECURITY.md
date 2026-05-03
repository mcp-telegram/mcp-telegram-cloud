# Security Policy

## Reporting a vulnerability

If you find a security issue, **please do not open a public GitHub issue**.

Email the maintainer directly at **security@mcp-telegram.com**
(also reachable via the contact listed at
[mcp-telegram.com](https://mcp-telegram.com)). Self-hosters should
replace this address with their own operator contact before publishing
a fork.

Please include:

- A clear description of the issue and its impact.
- Steps to reproduce (PoC welcome, but not required).
- Affected version / commit SHA.
- Your disclosure timeline expectations.

We aim to acknowledge reports within **72 hours** and to ship a fix or
mitigation within **14 days** for high-severity issues. Coordinated
disclosure is appreciated — we will credit you in the release notes unless
you prefer to stay anonymous.

## Scope

In scope:

- `src/` (runtime code): OAuth flow, MCP handler, session manager, rate
  limiter, admin endpoints, logging.
- `Dockerfile`, `docker-compose.example.yml`, `.github/workflows/*.yml` (supply chain).
- `.env.example` defaults that could lead to insecure production deploys.

Out of scope:

- Upstream [`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram)
  — report those on the upstream repo.
- [gram.js / telegram](https://github.com/gram-js/gramjs) MTProto library.
- Third-party MCP clients (Claude.ai, ChatGPT, etc.).
- Social-engineering or physical attacks.
- DoS via legitimate traffic volume (see Rate limiting below — open a
  regular issue if you have an improvement).

## Threat model

This service holds **live Telegram MTProto sessions** on behalf of its
users. A breach of the session database means a full-account compromise
equivalent to an attacker cloning the victim's Telegram app. Treat the
database as the crown jewel.

### What we protect against

- **Admin endpoint abuse** — `ADMIN_TOKEN` is compared with
  `timingSafeEqual` to prevent timing oracles.
- **Rainbow-table lookup of user IDs in logs** — IDs can be replaced with
  HMAC hashes (`LOG_USER_IDS=false` + `LOG_HASH_SALT`).
- **Unbounded OAuth abuse** — per-IP rate limit on `/oauth/*` (see
  `OAUTH_RATE_LIMIT`).
- **Secret leaks in git history** — pre-commit `gitleaks` hook.
- **XSS in user-controlled metadata** — JSON-LD output is escaped; Hono
  JSX auto-escapes by default.
- **Log bloat / indefinite retention** — `USAGE_LOG_RETENTION_DAYS` purges
  old rows daily (default 90d).

### Privacy contract — what enters telemetry

Outbound telemetry (logs/metrics/traces to SigNoz) is gated by the
`MCP_TELEGRAM_TELEMETRY` master switch:

| Mode         | SQLite `usage_log` | Console / docker logs | OTLP → SigNoz | In-memory error buffer |
|--------------|:------------------:|:---------------------:|:-------------:|:----------------------:|
| `local-only` *(default)* | ✅ | ✅ | ❌ | ✅ |
| `on`         | ✅ | ✅ | ✅ (if `SIGNOZ_ENDPOINT` set) | ✅ |
| `off`        | ✅ | ❌ | ❌ | ✅ |

**Allowed in any mode** (recorded in usage_log + log attrs):

- Tool name (e.g. `telegram-list-chats`)
- MCP client classification (`claude`, `chatgpt`, `browser`, `bot`, `script`, `other`)
- HTTP method, route template, status class, duration
- Component / event labels we author (`component=oauth`, `event=token.issued`)
- HMAC-hashed user id (10-hex-char prefix; HMAC key `LOG_HASH_SALT`)
- Aggregate counts (DAU, calls/day)

**Never recorded** (CI gate: `pnpm check-telemetry` runs in `.github/workflows/build.yml` on every push and blocks the build on any finding):

- Raw Telegram user id, peer id, chat id, message id, message text
- Phone, email, first/last name, username
- MTProto session string, auth key, API hash
- OAuth `code`, `state`, access tokens, refresh tokens
- HTTP query strings (only the route path)
- `Authorization` and `Cookie` headers
- Any Telegram update payload bodies

**For self-hosters**: the default `local-only` mode means a fresh `docker run`
emits **zero outbound network traffic for telemetry**. The
`/api/observability` page renders DAU, by-tool, by-client, and recent errors
straight from SQLite + an in-memory ring buffer (last 500 ERRORs, lost on
restart). Set `MCP_TELEGRAM_TELEMETRY=on` and `SIGNOZ_ENDPOINT=...` only when
you operate your own SigNoz and want centralized dashboards.

### What we do **not** protect against (self-hosters read this)

- **Plaintext session storage** — the SQLite DB contains MTProto session
  strings in plain text. File-system access = account takeover. Mitigations
  are a hosting concern, see [`docs/self-hosting.md`](./docs/self-hosting.md).
- **Malicious admin** — anyone with `ADMIN_TOKEN` can read all users'
  usage stats and import sessions. Rotate it aggressively and keep it out
  of untrusted environments.
- **Compromised host** — root access to the server = full compromise. No
  cryptographic separation between the web process and session storage.
- **Dependencies** — we bump deps aggressively but do not audit every
  transitive package. Run `pnpm audit` in your pipeline.

## Versioning and patches

Security fixes land on `main` and are shipped in the next Docker image
tag. We do **not** maintain long-lived support branches. Self-hosters
should track `main` or pin to a tagged release and upgrade promptly when a
security advisory is posted.

## Hardening checklist for self-hosters

See [`docs/self-hosting.md`](./docs/self-hosting.md) for the full
operations guide. The short version:

1. Generate a strong `ADMIN_TOKEN` and `LOG_HASH_SALT` (32 bytes hex).
2. Leave `LOG_USER_IDS` unset (default = HMAC-hashed). Only set
   `LOG_USER_IDS=true` for short local debugging — never in production.
3. Leave `MCP_TELEGRAM_TELEMETRY` unset (default = `local-only`, zero
   outbound). Set to `on` only if you run your own SigNoz.
4. Put the service behind TLS — never expose `:3000` directly.
5. Restrict the database volume to the service user (`0600`).
6. Back up the DB **encrypted** — it contains live sessions.
7. Firewall `/api/stats`, `/api/observability`, and `/api/import-session`
   to trusted IPs if possible.
8. Subscribe to this repo's releases for security advisories.
