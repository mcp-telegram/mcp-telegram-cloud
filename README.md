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
- Read, write and destructive tools. Destructive ones (delete, ban,
  leave) are off by default and enabled per user at `/my/settings`;
  write actions are shown to the user for confirmation by the client.
- OAuth 2.0 with dynamic client registration and PKCE (RFC 8414 +
  7591 + 7636). QR login is embedded in the OAuth authorize page —
  connect once; the client keeps its token and refreshes it silently.

## Quick start (hosted)

1. Open Claude.ai → Settings → Connectors → **Add custom connector**.
2. Server URL: `https://mcp.mcp-telegram.com/mcp`.
3. Click Connect. You will be redirected to scan a QR code with
   Telegram (Settings → Devices → Link Desktop Device).
4. Done. Ask Claude to read your unread messages, search chats, etc.

Directory listings for Claude and ChatGPT (as **Chatroost**) are in
progress. Until then, add `https://mcp.mcp-telegram.com/mcp` manually as a
custom MCP server.

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

The hosted service exposes almost the whole upstream catalogue (about 175
tools; `bun check-parity` lists the exact set), in three tiers:

- **Read** (`readOnlyHint: true`): chats, messages, search, topics,
  members, profiles, contacts, reactions, stories, stats, stickers, media
  download. Run without a confirmation in clients that honour hints.
- **Write**: send, forward, react, polls, pin, drafts, group and profile
  edits, media uploads (see below). Clients show the outgoing action for
  confirmation.
- **Hard to undo** (`destructiveHint: true`, not gated): editing a sent
  message, group info, a folder or business hours. Clients ask for a
  confirmation; the tools work without the opt-in below.
- **Destructive** (`destructiveHint: true`, e.g.
  `telegram-delete-message`, `telegram-ban-user`, `telegram-leave-group`):
  **off by default**. Each user turns them on at
  [`/my/settings`](https://mcp.mcp-telegram.com/my/settings) (sign in with
  a QR scan) and sees their history at `/my/audit`; a separate daily limit
  applies.

Three upstream tools are never exposed because they conflict with the
OAuth/QR session model: `telegram-login`, `telegram-logout` and
`telegram-terminate-session`. Stars tools are opt-in for self-hosters
(`MCP_TELEGRAM_ENABLE_STARS=1`).

## Downloading a voice note or file

Call `telegram-download-media` with `chatId`, `messageId`, and `file: true`.
The result includes a private `downloadId`, size, SHA-256, expiry, and an
owner-authenticated browser download link. Agents can retrieve the bytes
through the same MCP tool using `downloadId` and byte `offset`, without
extracting an OAuth token or printing the file's base64 into the conversation.
Snapshots last 15 minutes, are limited to 8 MiB, and disappear on restart.
See [the full flow, recovery cases, security model and release dependency](docs/downloads.md).

## Sending a local file

The media tools (`telegram-send-file`, `telegram-send-album`,
`telegram-send-voice`, `telegram-send-video-note`, `telegram-send-story`,
`telegram-set-profile-photo`) never take a filesystem path: the server runs
somewhere else, and MCP has no way to carry bytes in a tool call that would
not first drag them through the model's context. They take a `source` that is
either an `uploadId` or a public `https://` URL.

Bytes therefore travel over plain HTTP, outside the MCP transport, to
`POST /my/upload` — which accepts **the same OAuth access token your client
uses for `/mcp`**:

```sh
# 1. upload the bytes -> uploadId (valid ~15 min, single use, bound to you)
curl -s --http1.1 -X POST https://mcp.mcp-telegram.com/my/upload \
  -H "authorization: Bearer $TOKEN" \
  -F "file=@./screenshot.png;type=image/png"
# {"id":"upl_…","expiresAt":"…","size":12345,"mime":"image/png"}

# 2. hand that id to a tool
#    telegram-send-file { chatId: "me",
#                         source: { kind: "upload", uploadId: "upl_…" },
#                         caption: "…" }
```

`$TOKEN` is the access token your MCP client obtained during the OAuth flow;
where it is stored depends on the client (credential store, config file,
keychain). Any token that can call `/mcp` can call `/my/upload` — there is no
separate grant to request.

Notes:

- The `uploadId` is bound to the token's account, single-use, and expires
  (`UPLOAD_TTL_SECONDS`, 15 min by default). Upload immediately before the
  tool call, not in advance.
- The **filename you upload with is what the recipient sees**, and it also
  decides the MIME type Telegram reports, so send `report.md`, not `blob`. The
  name is sanitized server-side (leaf name only, control/bidi characters
  stripped, 255-byte cap); if nothing usable survives, the document is sent
  unnamed rather than under a guessed name. For the `https://` URL source the
  name comes from the last path segment of the URL.
- Per-file cap 50 MB, per-account pending quota 100 MB, and the endpoint is
  rate-limited per token — see [configuration](docs/configuration.md).
- Clients that cannot make arbitrary HTTP requests (no shell, no fetch tool)
  cannot use this path. For them the only option is a public `https://` URL,
  which the server fetches behind an SSRF guard.
- Browser uploads at `/my/uploads` still work exactly as before and remain
  CSRF-protected; the token path is for programmatic clients.

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

## Changes

User-visible changes to the hosted service — including the ones that alter how
often your AI client asks for confirmation, and which actions now need an
opt-in — are in [`CHANGELOG.md`](./CHANGELOG.md).

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

The pre-commit hook (`husky` + `biome check --staged`) runs Biome on
staged files and `gitleaks protect --staged` if Gitleaks is installed locally
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
