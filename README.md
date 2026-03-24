# MCP Telegram Cloud

Hosted MCP server for Telegram — connects your Telegram account to Claude AI and ChatGPT via QR code login.

Read-only access: read messages, search chats, get contacts, download media. Cannot send, edit, or delete anything.

**Production**: [mcp-telegram.com](https://mcp-telegram.com)

## Architecture

- **Transport**: Streamable HTTP (`/mcp` endpoint)
- **Auth**: OAuth 2.0 (RFC 8414 + RFC 7591 + RFC 9728 + PKCE S256)
- **Login**: QR code via MTProto (same as Telegram Desktop)
- **Storage**: SQLite (sessions, OAuth tokens, usage logs)
- **Deploy**: Docker Swarm + Traefik v3 + Let's Encrypt

## Stack

- [Hono](https://hono.dev) — HTTP framework + JSX pages
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server
- [@overpod/mcp-telegram](https://github.com/overpod/mcp-telegram) — Telegram MTProto client
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — embedded database
- [Biome](https://biomejs.dev) — linter + formatter

## MCP Tools

| Tool | Description |
|------|-------------|
| `telegram-status` | Check connection status |
| `telegram-list-chats` | List dialogs with filtering |
| `telegram-read-messages` | Read messages with pagination |
| `telegram-search-chats` | Search chats by name, description, member count |
| `telegram-search-global` | Search messages across all public chats and channels |
| `telegram-search-messages` | Full-text search in messages |
| `telegram-get-unread` | Get unread chats with per-topic breakdown for forums |
| `telegram-mark-as-read` | Mark a chat as read |
| `telegram-get-chat-info` | Chat details and metadata |
| `telegram-get-chat-members` | Group/channel members |
| `telegram-get-contacts` | Contacts list |
| `telegram-get-contact-requests` | Incoming messages from non-contacts |
| `telegram-get-profile` | Detailed user profile (bio, photo, last seen, premium) |
| `telegram-get-profile-photo` | Download profile photo inline or to file |
| `telegram-get-reactions` | Get reactions on a message with user details |
| `telegram-list-topics` | List forum topics with unread counts |
| `telegram-read-topic-messages` | Read messages from a specific forum topic |
| `telegram-download-media` | Download photos inline |

All tools are annotated as read-only (`readOnlyHint: true`).

## Project Structure

```
src/
  server.tsx          — Hono app, routes, startup
  mcp-handler.ts      — MCP session management
  tools.ts            — Read-only MCP tool definitions
  oauth.ts            — OAuth 2.0 provider (RFC 8414/7591/9728/7009)
  qr-login.ts         — QR code login via MTProto
  session-manager.ts  — SQLite session storage
  usage.ts            — Usage tracking and rate limiting
  logger.ts           — Structured logging (OTLP)
  styles.ts           — Hono CSS design tokens
  icon.ts             — Telegram SVG icon
  pages/
    Layout.tsx        — Shared HTML layout
    LandingPage.tsx   — Landing page
    AuthorizePage.tsx — OAuth authorize + QR
    LoginPage.tsx     — Standalone QR login
stacks/
  mcp-telegram.yml    — Docker Swarm service
  traefik.yml         — Traefik reverse proxy
```

## Development

```bash
npm install
npm run dev        # tsx watch
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_API_ID` | Yes | Telegram API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | Yes | Telegram API hash |
| `ADMIN_TOKEN` | Yes | Token for admin API endpoints |
| `ISSUER` | No | OAuth issuer URL (default: `https://mcp-telegram.com`) |
| `PORT` | No | HTTP port (default: `3000`) |

## Build & Deploy

```bash
# Build Docker image
docker build -t mcp-telegram-cloud .

# Deploy with Docker Swarm
docker stack deploy -c stacks/mcp-telegram.yml mcp-telegram
```

CI/CD via GitHub Actions: push to `main` or tag `v*` triggers build, deploy, and release.

## Related

- [mcp-telegram](https://github.com/overpod/mcp-telegram) — open-source self-hosted version (read + write, all tools)
