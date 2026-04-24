# Self-Hosting Guide

This guide covers running `mcp-telegram-cloud` on your own infrastructure.
If you only want to try the hosted service, skip this — go to
[mcp-telegram.com](https://mcp-telegram.com).

## Who should self-host

- You don't trust a third party with your Telegram session.
- You run a private community and need the service inside a trusted
  network.
- You want to modify or extend the server.

## Who should **not** self-host

- You want a casual, zero-ops setup — use the hosted service.
- You cannot commit to running security updates promptly. A stale
  deployment with live MTProto sessions is a liability.

## Threat model — read this first

The SQLite database stores **live Telegram MTProto session strings in
plain text**. Anyone with read access to the database file can clone each
user's Telegram account without their knowledge. There is **no
application-level encryption** of sessions at rest.

Mitigations must live outside the application:

- Full-disk encryption on the host (LUKS, FileVault, APFS encrypted
  volume).
- Strict filesystem permissions on the DB file and volume (`0600`).
- Encrypted backups. Never push plaintext DB dumps to object storage.
- Host hardening: minimal attack surface, SSH keys only, firewall.
- No shared access. Every root user on the host is effectively a
  Telegram-session admin.

If you can't guarantee the above for every environment the DB touches
(including backups), do not self-host.

## Requirements

- Docker 24+ and Docker Compose, **or** Node.js 22+ and pnpm 10+.
- A public HTTPS endpoint — OAuth clients (Claude.ai, ChatGPT) will not
  talk to a plaintext HTTP service.
- Telegram API credentials from <https://my.telegram.org/apps>.
- A domain you control. Used for OAuth issuer URLs — changing `ISSUER`
  later invalidates all issued access + refresh tokens, all registered
  OAuth clients (RFC 7591), and forces every connected Claude.ai /
  ChatGPT user to re-authorize and rescan their QR code. Pick once.

## Required environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_API_ID` | ✅ | Numeric ID from my.telegram.org. |
| `TELEGRAM_API_HASH` | ✅ | Hex hash from my.telegram.org. |
| `ISSUER` | ✅ | Public HTTPS URL, no trailing slash. |
| `ADMIN_TOKEN` | ✅ | 32-byte hex. See `.env.example` for generator. |

All other vars are optional with safe defaults — see
[`.env.example`](../.env.example) for the full list.

## Hardening checklist

### 1. Generate strong secrets

```bash
# ADMIN_TOKEN and LOG_HASH_SALT
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store them in your secrets manager (GitHub Secrets, Docker secrets,
Vault, 1Password, etc.) — **never** commit them. The pre-commit
`gitleaks` hook will catch obvious leaks but is not a substitute for
discipline.

### 2. Hash user IDs in logs

```env
LOG_USER_IDS=false
LOG_HASH_SALT=<your-32-byte-hex>
```

Telegram user IDs are numeric and have a small enough space that
unsalted hashes can be brute-forced. The HMAC salt closes that gap.
Rotating the salt breaks correlation across log epochs — do this once
per incident, not as a routine.

> ⚠️ If `LOG_HASH_SALT` is left empty, `src/config.ts` falls back to a
> well-known default string baked into the repo. That fallback provides
> **zero** protection against rainbow-table lookup — anyone with the
> source can rebuild the mapping. Always set your own salt in production.

### 3. Restrict the database volume

On the host:

```bash
chmod 0700 /var/lib/mcp-telegram/data
chown 1000:1000 /var/lib/mcp-telegram/data   # match the container user
```

In `stacks/*.yml`, bind-mount read-write only for the app; do not expose
the volume to other services.

### 4. Enforce TLS

Never expose port 3000 directly. Front the service with:

- Traefik with Let's Encrypt (this repo's upstream deployment uses
  this — see `stacks/traefik.yml`).
- nginx + certbot.
- Caddy with automatic HTTPS.

Terminate TLS at the proxy and forward to the container over a private
network.

### 5. Configure OAuth rate limits

Defaults (30 requests / 60s per IP across `/oauth/*`) are tuned for a
small public deployment. Tighten for a private one:

```env
OAUTH_RATE_LIMIT=10
OAUTH_RATE_WINDOW_MS=60000
```

Set `OAUTH_RATE_LIMIT=0` to disable (only if you're behind another
rate-limiting layer like Cloudflare).

### 6. Lock down admin endpoints

`/api/stats` and `/api/import-session` are protected only by the bearer
`ADMIN_TOKEN`. For extra defence, restrict them at the proxy layer:

```nginx
location /api/ {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://app:3000;
}
```

### 7. Back up — encrypted only

```bash
# Example: encrypted SQLite backup to S3-compatible storage
sqlite3 /var/lib/mcp-telegram/data/cloud.db ".backup /tmp/cloud.db"
gpg --symmetric --cipher-algo AES256 /tmp/cloud.db
aws s3 cp /tmp/cloud.db.gpg s3://your-bucket/backups/
rm /tmp/cloud.db /tmp/cloud.db.gpg
```

Never store the passphrase on the same host as the database.

### 8. Retention

```env
USAGE_LOG_RETENTION_DAYS=90   # 0 = keep forever — not recommended
```

Usage logs accumulate quickly. The default retention of 90 days balances
debugging against blast radius if the DB is exfiltrated.

### 9. Observability (optional)

Pointing `SIGNOZ_ENDPOINT` at a remote OTLP collector lets you correlate
`rate_limit.exceeded` and `http.request` events across replicas. Logs
are PII-safe by default when `LOG_USER_IDS=false`.

## Incident response

If you suspect the database file has been accessed by an unauthorized
party, **assume every stored MTProto session is compromised**. Options
from fastest to most thorough:

1. **Kill every live session immediately** — stop the service, clear
   the sessions table:
   ```bash
   sqlite3 /var/lib/mcp-telegram/data/cloud.db \
     "DELETE FROM sessions; DELETE FROM oauth_tokens; DELETE FROM oauth_codes;"
   ```
   This forces all users to re-authenticate on next connect. It does
   **not** revoke sessions on Telegram's side — the attacker can still
   use an exfiltrated session string until each user terminates it in
   Telegram.
2. **Notify users out-of-band** and ask them to open Telegram →
   Settings → Devices → Terminate all other sessions. This is the only
   step that invalidates stolen session strings on Telegram's servers.
3. **Rotate** `ADMIN_TOKEN`, `LOG_HASH_SALT`, and `TELEGRAM_API_HASH`
   if you believe they leaked too.
4. **Post-mortem**: check SigNoz / `usage_log` for access from unusual
   IPs before the kill switch.

Document your incident contact in `CONTACT_EMAIL` / `CONTACT_TELEGRAM`
so affected users have somewhere to reach you.

## Upgrading

1. Watch releases: <https://github.com/mcp-telegram/mcp-telegram-cloud/releases>.
2. Pin to a tag, not `main`. Pull the new image, restart the stack.
3. After a bump to `@overpod/mcp-telegram`, re-run the MCP smoke test
   with an existing session to catch protocol breakage early.
4. DB migrations are currently applied at startup — **back up before
   every upgrade**.

## Known limitations

- **Single-process only**. In-memory rate-limit buckets and OAuth state
  are not shared across replicas. Scale vertically or put a shared
  rate-limiter (nginx, Cloudflare) in front.
- **No horizontal HA for session storage**. SQLite is single-writer. For
  multi-host you'd need to swap the storage layer — not in scope.
- **No built-in MFA** for admin endpoints beyond the bearer token.

## Reporting issues

Security issues: see [`SECURITY.md`](../SECURITY.md).

Everything else: GitHub issues on this repo.
