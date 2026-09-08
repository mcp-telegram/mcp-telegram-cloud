# Changelog

Notable changes to the hosted service at `mcp.mcp-telegram.com`, written for
the people who use it. The full commit history is on GitHub; this file only
records what you can notice or need to act on.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are the ones tagged on this repository.

## [2.56.0] — 2026-09-08

### Security

- The authorization page built an inline script out of the OAuth request
  parameters (`state`, `client_id`, `redirect_uri`) using `JSON.stringify`,
  which does not escape `</script>`. A crafted link could therefore close the
  script element and run arbitrary markup on that page. Values are now escaped
  so they cannot terminate the element. The page shipped in production renders
  through a different code path, so exploitation required the fallback page to
  be in use — but the hole was real and is now closed, with a regression test.

### Fixed

- The consent screen said the client "wants **read-only** access to your
  Telegram" while the connector exposes tools that send, edit and manage
  chats. It now describes what is actually granted, and says that irreversible
  actions stay off until you enable them. If you connected before this change,
  you agreed to a description that understated the access — please re-read it
  and disconnect if it is not what you want.

## [2.55.2] — 2026-09-08

### Security

- Review-access tokens are stored as SHA-256 hashes instead of plaintext, so a
  leaked database or backup cannot be replayed. Existing links keep working.
- The `/review` endpoint is rate-limited (`REVIEW_RATE_LIMIT`, default 10 per
  15 minutes per IP) and no longer logs client IP addresses.

## [2.55.0] — 2026-09-08

### Changed

- **Your AI client will ask for confirmation more often.** Every tool carries
  MCP hints that tell ChatGPT and Claude how risky an action is, and ours were
  wrong: all 174 tools claimed their effects never left your account, including
  the ones that deliver messages to other people. 74 tools are now marked as
  affecting the outside world. Nothing about the tools changed — only the
  honesty of what we tell your client about them.
- **More actions now require your opt-in.** The irreversible-action gate
  (off by default, per-account, at `/my/settings`) previously covered 11 tools.
  It now covers 24, including banning and kicking users, removing admins,
  leaving a group, closing a poll, filing reports, deleting a profile photo and
  enabling auto-delete. If one of these stops working with a refusal, that is
  the gate — switch it on if you want it. Measured before shipping: none of the
  newly gated tools had been called in the previous 90 days.

### Removed

- `telegram-send-paid-reaction` is disabled on the hosted service. It spends
  Telegram Stars, i.e. money, on a model's initiative. It had no calls in 90
  days. Self-hosters can re-enable it with `MCP_TELEGRAM_ENABLE_STARS=1`.

## [2.54.12] — 2026-09-08

### Added

- Review-access links: a revocable, time-limited URL that grants a prepared
  demo account to a browser without the Telegram QR code. Built so plugin
  directory reviewers can test the connector at all — they have no phone signed
  into the account. Issued by the operator only; see `docs/configuration.md`.

## [2.54.11] — 2026-09-08

### Fixed

- The privacy policy was wrong in three places, and is rewritten in all 20
  languages:
  - it claimed we do not collect "phone numbers, contact lists, or profile
    data", while `telegram-get-contacts` returns exactly that to your AI
    client. Access and storage are now described separately, with a new
    section listing everything the connector can reach.
  - it said OAuth tokens are "stored in memory, not persisted". They are stored
    in our database and deleted when you disconnect.
  - it did not mention the audit record kept for irreversible actions, which
    includes a short summary of the arguments (up to 200 characters, which can
    contain a chat identifier and the beginning of a message). Retention for
    usage logs and that audit is 90 days, now stated.

## Earlier

Releases before 2026-09-08 are documented only in the commit history.
