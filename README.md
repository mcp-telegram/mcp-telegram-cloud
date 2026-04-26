# MCP Telegram Cloud

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Hosted](https://img.shields.io/badge/hosted-mcp--telegram.com-2AABEE)](https://mcp-telegram.com)

Open source MCP server that connects a Telegram account to AI assistants
(Claude.ai, ChatGPT) over OAuth + QR login. Hosted free at
[mcp-telegram.com](https://mcp-telegram.com), or self-host on your own
infrastructure.

This is the **cloud / multi-user** flavour. For the single-user CLI
(stdio transport, full read+write, all MTProto tools), use the upstream
[`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram).

## What it does

- Exposes a Telegram account to an MCP-aware client (Claude.ai, ChatGPT
  Apps, custom MCP hosts) over Streamable HTTP.
- **Read-only and safe-state-change tools only** — no `send-message`,
  no `delete-message`, no admin actions. The hosted service trades off
  capability for a smaller blast radius.
- OAuth 2.0 with dynamic client registration and PKCE (RFC 8414 +
  7591 + 7636). QR login is embedded in the OAuth authorize page —
  connect once, reconnect via refresh token for 30 days.

## Quick start (hosted)

1. Open Claude.ai → Settings → Connectors → **Add custom connector**.
2. Server URL: `https://mcp-telegram.com/mcp`.
3. Click Connect. You will be redirected to scan a QR code with
   Telegram (Settings → Devices → Link Desktop Device).
4. Done. Ask Claude to read your unread messages, search chats, etc.

ChatGPT Apps Directory submission is in review. Until then, add
`https://mcp-telegram.com/mcp` manually as a custom MCP server.

## Quick start (self-hosted)

```bash
git clone https://github.com/mcp-telegram/mcp-telegram-cloud.git
cd mcp-telegram-cloud
cp .env.example .env
# fill in TELEGRAM_API_ID + TELEGRAM_API_HASH (from https://my.telegram.org/apps)
# and ISSUER (your public HTTPS URL). ADMIN_TOKEN is optional but
# recommended — without it admin-only operations on /api/* (stats,
# operator-side session import) return 401.
docker compose -f docker-compose.example.yml up -d --build
```

The example compose file binds to `127.0.0.1:3000` and **does not include
TLS termination**. OAuth clients require HTTPS, so put a reverse proxy
in front (Traefik, nginx + certbot, Caddy, managed LB). See
[`docs/self-hosting.md`](./docs/self-hosting.md) for the threat model,
hardening checklist, and incident response.

> ⚠️ The session database stores live MTProto session strings in
> plaintext. Read [`docs/self-hosting.md`](./docs/self-hosting.md)
> §Threat model before running this in production.

## MCP tools exposed

Cloud whitelists a subset of the upstream tools. All are annotated
`readOnlyHint: true` or are safe state-changes (mark-as-read, mute).

**Read & search**

- `telegram-status` — connection status
- `telegram-list-chats` — dialogs with filtering
- `telegram-read-messages` — paginated message read
- `telegram-search-chats` — search chats by name / description / size
- `telegram-search-global` — full-text search across public chats and
  channels
- `telegram-search-messages` — full-text search inside a chat
- `telegram-get-unread` — unread chats with per-topic breakdown for
  forums

**Chat & member info**

- `telegram-get-chat-info` — chat details and metadata
- `telegram-get-chat-members` — group/channel members
- `telegram-get-chat-folders` — user's chat folders
- `telegram-list-topics` — forum topics with unread counts
- `telegram-read-topic-messages` — read messages from a forum topic
- `telegram-get-invite-links` — chat invite links
- `telegram-get-reactions` — message reactions with user details

**Profiles & contacts**

- `telegram-get-profile` — detailed user profile (bio, photo, last
  seen, premium)
- `telegram-get-profile-photo` — download profile photo
- `telegram-get-contacts` — contacts list
- `telegram-get-contact-requests` — incoming non-contact messages

**Stickers**

- `telegram-get-sticker-set`
- `telegram-search-sticker-sets`
- `telegram-get-installed-stickers`
- `telegram-get-recent-stickers`

**Media**

- `telegram-download-media` — download photos and documents

**Safe state changes**

- `telegram-mark-as-read` — mark a chat as read
- `telegram-mute-chat` — mute notifications

**Account info**

- `telegram-get-sessions` — list active Telegram sessions

For the full upstream tool catalogue (including `send-message`,
`forward-message`, group admin, profile write, etc.), use the CLI
[`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram).

## Architecture

- **Transport**: Streamable HTTP (`/mcp`)
- **Auth**: OAuth 2.0 (RFC 8414 + 7591 + 7636/PKCE S256)
- **Login**: QR via MTProto, embedded in OAuth authorize page
- **Storage**: SQLite (sessions, OAuth tokens, usage log)
- **Telegram client**: [`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram)
  via Master/Client IPC — each user runs in an isolated worker
- **Pages**: Hono JSX (landing, OAuth authorize, privacy, terms)
- **Observability**: structured logs to OTLP HTTP (SigNoz, Grafana
  Cloud, etc.), or stderr if `SIGNOZ_ENDPOINT` is empty
- **Deploy**: Docker. Production runs Docker Swarm + Traefik.

See [`docs/architecture.md`](./docs/architecture.md) for the component
map, request lifecycles, and storage layout.

## Configuration

All runtime config is environment variables. Required:
`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `ISSUER`. `ADMIN_TOKEN` is
recommended — admin-only operations on `/api/*` (stats, operator-side
session import) return `401` without it.

Full reference with required-vs-optional flags and change-impact
warnings: [`docs/configuration.md`](./docs/configuration.md).

## Development

```bash
pnpm install
cp .env.example .env
pnpm dev          # tsx watch
pnpm test         # unit tests (node:test)
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome
pnpm build        # tsc → dist/
```

The pre-commit hook (`husky` + `lint-staged`) runs Biome on staged
files and `gitleaks protect --staged` if Gitleaks is installed locally
(`brew install gitleaks`). The same scan plus TruffleHog runs in CI on
every PR.

## Contributing

PRs welcome. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first —
it covers the cloud-vs-upstream scope split, dev setup, and the
"won't merge" list. By contributing you agree to the
[Code of Conduct](./CODE_OF_CONDUCT.md). See [`ROADMAP.md`](./ROADMAP.md)
for what's planned, what's deferred, and what's explicitly out of scope.

Tool-level features (new `telegram-*` MCP tools, MTProto coverage)
belong in the upstream
[`mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram) repo.
This repo handles hosting concerns: OAuth, multi-user session storage,
rate limiting, landing pages, ops.

## Maintenance

Maintained by **one person** in spare time. Expected response time on
issues and PRs: ~2-3 days. No SLA, no paid support tier — but the
hosted service is best-effort kept up.

Status updates land via the
[@mcp_telegram_cloud_bot](https://t.me/mcp_telegram_cloud_bot) Telegram
bot (subscribe via `/start`).

## Security

Vulnerability disclosure: see [`SECURITY.md`](./SECURITY.md). Please
**do not** open public issues for security problems.

## License

[MIT](./LICENSE) © overpod, 2025-2026.
