# Roadmap

Public roadmap for `mcp-telegram-cloud`. This is a **living document** — items move,
priorities shift, dates are not promises. Maintained by one person in spare time
(see [README §Maintenance](README.md#maintenance)).

**Last updated:** 2026-05-04
**Current version:** 2.21.0 (cloud — idle MCP-session reaper closes the abandoned-session leak) / [`@overpod/mcp-telegram` 1.36.1](https://github.com/mcp-telegram/mcp-telegram) (upstream)

---

## Goal

**Full 1:1 parity with upstream `@overpod/mcp-telegram` — 181/181 tools.**

As of v2.14.0 the cloud whitelist covers **172 of 181 upstream tools (~95%)** —
**100% of what is achievable on a shared HTTP server**. The remaining 9 are
all `EXPLICIT_EXCLUDED`: 6 filesystem-bound send tools (Phase X — needs an
upload-path design), and 3 auth-lifecycle tools that conflict with cloud's
OAuth/QR flow (`telegram-login`, `telegram-logout`, `telegram-terminate-session`).
The 11 destructive tools shipped in v2.14.0 behind a per-user opt-in toggle
(server-default OFF) at `/my/settings`, with an `/my/audit` history view and
a separate `DESTRUCTIVE_DAILY_LIMIT` quota independent of `FREE_TIER_LIMIT`.
Stars parity is complete in opt-in form (`MCP_TELEGRAM_ENABLE_STARS=1`).
Tracked in [`scripts/parity-baseline.json`](scripts/parity-baseline.json) —
`pending` is now `[]` — and gated in CI by `pnpm check-parity`.

## Now (in flight)

Things actively being worked on or about to ship.

- **Observability hardening** — external uptime monitoring + manual SigNoz
  alerts (8 rules: 4 rate-limiter, 4 SLA). Dashboards already live;
  alert delivery via Telegram bot to admin remains. Phase 0.2 tail.

## Next (planned, not started)

Ordered by current intent. Subject to change as decisions are locked.

- **Per-user burst rate limit** (Layer 3) —
  trigger: ≥10 daily active users sustained 7 days. Currently
  Layer 1 (per-IP HTTP rate-limit on `/oauth/*`, 30 req/min) and Layer 2
  (per-user daily quota, default 100 calls/day via `FREE_TIER_LIMIT`) are
  live; Layer 5 (per-method soft limits) only if real flood statistics
  demand it.

## Later (likely, no commitment)

Direction is set, but timing depends on usage signals or external events.

- **Phase X — Filesystem upload path**. Unblocks the last 5 currently
  excluded tools (`telegram-send-file`, `-send-voice`, `-send-video-note`,
  `-send-album`, `-send-story`). They require an absolute path on the
  cloud container's filesystem, which the user does not control. Needs a
  design call: presigned upload URL vs. multipart `/upload` endpoint vs.
  HTTPS-fetch from a user-supplied URL; ephemeral container disk vs.
  object storage; per-user upload quota. Deferred until non-FS parity is
  closed (Wave 2.3 → 2.7 + Phase 2.1) — at that point only these 5 tools
  are gated on it.
- **`MCP_TELEGRAM_ENABLE_STARS=0` in default cloud image**. Stars
  remains opt-in via env flag for self-hosters; the hosted
  `mcp-telegram.com` image does not register Stars tools by default
  (matches the broader "no paid ecosystem on hosted free tier" stance,
  with no judgment on Stars itself).
- **Proxy pool** — currently single-IP. Activation is investigation-led,
  not automatic.
  Signals to investigate: SigNoz alerts A1 (`flood_wait > 10/hour`) or A2
  (`> 50/hour`), 10+ DAU sustained 7 consecutive days, or repeated user
  reports of unexplained session drops. `AUTH_KEY_DUPLICATED` is treated
  first as an IPC / single-flight bug, not as a proxy-pool trigger.
  Shortlisted infrastructure: datacenter VPS pool (~$20-40/mo, 5 IPs across
  3 regions) → residential proxies (~$50-200/mo) only on escalation.
- **Settings page + audit log UI** (`/settings`, `/my/audit`) for
  destructive-tools opt-in and history visibility. Required by Group C/E
  expansion.
- **Per-method adaptive rate limiter** — only if real flood statistics
  show it's needed. Reactive strategy is currently sufficient
  (FLOOD_WAIT auto-retry).
- **Session encryption at rest** — currently sessions are stored as
  plaintext in SQLite (mirrors TDLib / Telegram Desktop). Threat model
  documented in [`SECURITY.md`](SECURITY.md) and
  [`docs/self-hosting.md`](docs/self-hosting.md). May add AES-GCM with
  ENV-supplied key if community asks.
- **Status page** at `mcp-telegram.com/status` — current service health
  (ok / maintenance / incident) with in-response banner middleware for
  active incidents.

## Not planned (out of scope)

Explicitly **not** on the roadmap. If this changes, it'll be noted in the
"Done" section below.

- **Donate / paid tiers** — currently not accepted; revisit conditional on
  legal/banking changes that allow individual contributors to receive
  funds. The hosted service is best-effort free; self-hosting is always
  available as the primary path. See Phase 0.4 in the working plan.
- **Bot API support** — this server is MTProto-only. Bots have their
  own much simpler ecosystem; no value to duplicate it here.
- **Web UI for chat / messaging** — out of scope; this is an MCP server,
  not a Telegram client. Use the official clients for that.
- **Multi-account per user** — one Telegram account per cloud user.
  Multi-account complicates session storage, OAuth, and rate-limit
  accounting; not enough demand to justify the cost.
- **`telegram-terminate-session` will not be exposed**. Permanently in
  `EXPLICIT_EXCLUDED`. The upstream tool is dual-mode — terminate one
  specific session by hash, or `terminateAllOther=true` to revoke every
  session except the caller's. The "all other" path is the concern: a
  prompt-injected LLM call could revoke the user's official Telegram
  clients on phone/desktop while the cloud session keeps working,
  leaving the user locked out of their own UI. The risk-vs-utility
  asymmetry is unfavorable. To revoke a Telegram session, use the
  official Telegram clients.

## Done (recent highlights)

- **2026-05-04** — **Idle MCP-session reaper** (cloud v2.21.0).
  Closes the abandoned-session leak documented as KNOWN LIMITATION in v2.20.1.
  SigNoz observation triggered the fix: chatgpt bucket on `mcp.sessions.by_client`
  reached 12 vs 1 real session, claude bucket 5 vs 2 real, drift growing ~1
  every 1.5 min. Fix: track `lastActivity: Map<sid, number>` updated on every
  request reuse + on init; periodic timer (`MCP_IDLE_REAP_INTERVAL_MS`,
  default 60s) sweeps `transports` and reaps entries older than
  `MCP_IDLE_REAP_MS` (default 10min). Reaper drives `teardownSessionImpl`
  directly (covers SDK silent-stream-cancel) AND calls `transport.close()`
  (idempotent via `sessionClient.has(sid)` guard). Module-level
  `teardownSessionImpl` extracted from former closure so the reaper and the
  request-handler share accounting. New 7-test suite drives reaper through
  fresh/stale isolation, threshold=0 disables, sync-throw + async-reject
  survival, idempotent second sweep. /sc:analyze APPROVE-FOR-SHIP with
  2 MEDIUM follow-ups (async-reject test gap + cleanupTimers reset gap),
  both fixed inline. /sc:cleanup NO-OP with per-candidate rationale.
  458/458 tests, parity 178/3/0 unchanged.

- **2026-05-04** — **`client` label on MCP sessions gauge** (cloud v2.20.0).
  New metric `mcp.sessions.by_client` (gauge, label `client` ∈ `{claude, chatgpt, browser, bot, script, empty, other}`)
  exposes per-client MCP transport sessions to SigNoz. Captured at session-init from
  the request UA via `classifyClient()` (now extracted to `src/middleware/classify-client.ts`
  as the single source of truth for the bounded `CLIENT_CLASSES` const). Distinct from
  pre-existing `mcp.sessions.active` which reflects the Telegram pool size; both ship.
  7 gauge providers registered upfront so the legend stays stable across deploys, even
  for quiet buckets. **Known limitation**: SDK fires `_onsessionclosed` only on DELETE /mcp;
  abandoned sessions (network drop, process exit) leak gauge state until container
  restart — symmetric with pre-existing leak on `transports`/`activeSessionCount`. Metric
  honestly described as "initialized-and-not-yet-closed". `transport.onclose` wired for
  future explicit-close paths with idempotent guard. Idle-reaper TTL is the proper fix;
  tracked as follow-up. 451/451 tests, parity 178/3/0 unchanged. Two-pass review (/sc:analyze + Copilot CLI)
  caught and corrected an over-claim in the initial commit before deploy.

- **2026-05-04** — **Phase A.2: compile-time PII whitelist for log attributes** (cloud v2.17.3).
  New `LogFields` type (`src/telemetry/log-fields.ts`) closes the unknown-key gap
  in structured logging: `logger.{error,warn,info,debug}` and `recordError` now
  accept only a closed list of allow-listed attribute keys (e.g. `component`,
  `event`, `userId`, `tool`, `count`, `error`, …). Any new caller passing a
  PII-shaped key (`emailHash`, `ipAddr`, …) fails `pnpm typecheck` — the
  runtime grep guard (`pnpm check-telemetry`) is preserved as the second
  layer (catches blacklisted keys behind `// telemetry-allow` escape hatches).
  Two-layer defence symmetric with the SECURITY.md "Privacy contract" prose.
  Plus: 256-char value cap at the logger boundary (defense-in-depth on
  `error`/`context` strings carrying upstream-encoded payloads), single source
  of truth for `MAX_ATTR_VALUE_LEN`, `clientClass` enum split from raw OAuth
  `client_name` (avoids same-key collision in SigNoz aggregations), and
  `(?<!\.)\blogger` lookbehind on the runtime grep regex closes a latent
  false-positive on `obj.logger[x](...)`. 7 new tests (`log-fields.test.ts`
  for `// @ts-expect-error` regression coverage + truncation cap test +
  bracket-form regex tests). 386/386 tests, two review passes APPROVED.

- **2026-05-04** — **Telemetry export error visibility** (cloud v2.17.2).
  New `telemetry.export.errors` counter with labels `signal` ∈ `{logs, metrics}` ×
  `reason` ∈ `{auth_failed, server_error, client_error, network, unknown}` surfaces
  previously-silent OTLP fetch catches in `/api/observability`. Closes the v2.17.1
  diagnostic gap where prod `/health` returned 200 but zero data reached SigNoz.
  Both `logger.ts:flush()` and `metrics.ts:doFlush()` now check `response.ok` AND
  catch throws; `classifyExportError(Response | unknown)` returns one of the 5
  bounded reason buckets (no raw status codes / error messages → no label
  cardinality blow-up). 8 new tests (5 classifyExportError + 3 metrics flow + 2 logger flow).

- **2026-05-04** — **SigNoz HTTP Basic auth support** (cloud v2.17.1).
  New `SIGNOZ_AUTH="user:password"` env var attaches an `Authorization: Basic`
  header to every OTLP `POST /v1/logs` and `/v1/metrics`, so the exporter can
  ingest into a SigNoz instance fronted by a Traefik/nginx Basic-auth gateway.
  Empty value preserves the previous unauthenticated behaviour
  (`src/config.ts`, `src/logger.ts`, `src/telemetry/metrics.ts`). 4 new tests
  (2 metrics + 2 logger) cover header present/absent. No behaviour change
  for self-hosters whose SigNoz collector accepts unauthenticated OTLP.

- **2026-05-03** — **Phase B observability metrics shipped** (cloud v2.17.0).
  Custom zero-dep metrics layer (`src/telemetry/metrics.ts`) emitting
  counters, histograms and gauges over OTLP HTTP — same `MCP_TELEGRAM_TELEMETRY`
  kill-switch as logs, default `local-only` (zero outbound). Surface:
  `http.requests` + `http.duration` (route templated via
  `src/telemetry/route-template.ts`, status_class label),
  `mcp.tool.calls` + `mcp.tool.duration` (tool, outcome),
  `oauth.flow` (step × outcome), `rate_limit.hits` (tier × tool),
  gauges `mcp.sessions.active` and `uploads.pending.bytes`.
  `/api/observability` page now renders gauges + counter totals + p50/p95/p99
  histogram quantiles from in-process state — visible without SigNoz at all.
  18 new tests (343 → 358). Pattern intentionally mirrors `logger.ts`
  rather than introducing `@opentelemetry/sdk-node` — keeps transitive deps
  small and the kill-switch contract symmetric across logs/metrics.

- **2026-05-02** — **Phase 2.1 shipped** (cloud v2.14.0). 11 destructive
  tools out of pending into whitelist behind a per-user opt-in gate:
  `delete-message`, `delete-scheduled`, `delete-stories`, `delete-topic`,
  `delete-fact-check`, `clear-drafts`, `revoke-invite-link`,
  `toggle-forum-mode`, `set-chat-permissions`, `set-chat-reactions`,
  `edit-story`. Gating: a single `enable_destructive` toggle per user at
  `/my/settings` (server-default OFF), separate `DESTRUCTIVE_DAILY_LIMIT`
  quota independent of `FREE_TIER_LIMIT` (default 20/day, 0 = unlimited),
  and a `destructive_audit` table feeding `/my/audit`. Every gated
  invocation — including denied attempts — writes one audit row with
  `result ∈ {ok, error, denied_disabled, denied_quota}`. Auth on `/my/*`
  via the `tg_user` cookie + saved-session membership; CSRF on POST via
  exact-origin match. Cloud tightens vs upstream where reasonable
  (`edit-story` rejects `privacy='selected'` without a non-empty
  `allowUserIds`, `set-chat-permissions` requires at least one flag,
  `clear-drafts` rejects ambiguous chatId+confirmAllChats=both).
  `edit-story` ships without the `filePath` upstream field (FS-bound,
  Phase X). Coverage: whitelist 161 → **172 (~95% of 181) = 100%
  achievable**; baseline pending 11 → **0**. The only remaining gap to
  full 1:1 parity is the 9 EXPLICIT_EXCLUDED entries (6 FS-bound +
  3 auth-lifecycle).

- **2026-05-01** — **Phase 2 Wave 2.7 shipped** (cloud v2.13.0). 3
  Stars-write tools — `telegram-save-star-gift` (show/hide a received
  Star Gift on profile), `telegram-convert-star-gift` (non-reversible —
  convert gift back into Stars balance), `telegram-change-stars-subscription`
  (cancel/restore a Stars subscription). All gated by
  `MCP_TELEGRAM_ENABLE_STARS=1` (server-default OFF on the hosted image,
  consistent with Wave 3 RO Stars in v2.12.0). Annotation: WRITE
  (non-destructive) — Telegram tier=write; the convert path is
  non-reversible per Telegram itself but does not delete user data on
  the cloud side, so it shipped under the standard SAFE-write gate
  rather than waiting for Phase 2.1 destructive infrastructure. Each
  tool with two-mode peer addressing (`save`, `convert`) carries a
  `preValidate` enforcing `msgId` XOR `chatId+savedId`. Coverage:
  whitelist 158 → **161 (~89% of 181)**; baseline pending 14 → 11.
  Stars parity is now complete in opt-in form; remaining 11 pending
  are all destructive and gated on Phase 2.1.

- **2026-05-01** — **Phase 2 Wave 3 RO Stars shipped** (cloud v2.12.0).
  6 read-only Stars tools — `get-stars-status`, `get-stars-transactions`,
  `get-stars-subscriptions`, `get-stars-topup-options`,
  `get-available-star-gifts`, `get-saved-star-gifts`. Gated by
  `MCP_TELEGRAM_ENABLE_STARS=1`; server-default OFF on the hosted image
  (zero behavioral change for current users). All 6 promoted out of
  `EXPLICIT_EXCLUDED`. Coverage: whitelist 152 → 158 (~87.3% of 181).

- **2026-04-30** — **Phase 2 Wave 2.5 shipped** (cloud v2.11.0). 22
  SAFE WRITE tools across three domains — groups (`create-group`,
  `edit-group`, `invite-to-group`, `join-chat`, `leave-group`), invite
  links (`create-invite-link`), topics (`create-topic`, `edit-topic`),
  polls (`create-poll`, `close-poll`), messaging (`pin-message`,
  `unpin-message`, `send-scheduled`, `inline-query-send`, `press-button`,
  `transcribe-audio`, `edit-fact-check`), broadcast toggles
  (`toggle-channel-signatures`), and story actions (`toggle-story-pinned`,
  `toggle-story-pinned-to-top`, `read-stories`, `report-story`).
  Coverage: whitelist 130 → 152 (~84% of 181); baseline pending 36 → 14.
  `edit-group.photoPath` deliberately omitted (FS-bound, parity with
  send-file/voice/etc.). Remaining 14 pending tools all upstream-
  DESTRUCTIVE (or Stars-paid) — go to Phase 2.1 / Wave 2.7. Saved-
  Messages alias `"me"`/`"self"` mirrored from upstream's `getMe()`
  pre-resolve in `send-scheduled` (cloud's `resolvePeer` only intercepts
  `"@me"`). 22 cross-field preValidates for poll/group/topic/button/
  schedule sanity. Premium/Business gating via existing `premiumOnlyOnError`
  helper for `transcribe-audio`. typecheck + lint + 157/157 tests +
  parity gate green. /sc:analyze 1 MEDIUM (`send-scheduled` "self" alias
  was unresolved) verified in code BEFORE fix and patched. /sc:cleanup
  verdict = NO-OP (all candidate refactors below the 3+ occurrence bar).
  Copilot CLI APPROVED 1 pass (no findings worth fixing).
- **2026-04-30** — **Phase 2.0.6 — `tools.ts` split refactor** (cloud
  v2.10.0). Pure code-quality cleanup, **mandatory before Wave 2.5**.
  `src/tools.ts` 3354 → 54 lines (barrel) + new `src/tools/` directory
  with 7 domain modules and one helpers module: `_helpers.ts` (171 lines,
  shared `sanitize`/render-functions/annotation constants/error mappers),
  `read.ts` (39 read-only tools), `messaging.ts` (20 send/edit/forward/
  reactions/drafts), `chats.ts` (20 moderation/folders), `profile.ts`
  (24 profile/business/privacy/emoji writes), `stories.ts` (7),
  `stats.ts` (7 admin-log/boosts/sessions), `misc.ts` (13 stickers/
  polling/inline/quick-replies/group-calls). External API preserved —
  `TOOLS` and `registerAllAllowedTools` still exported from `tools.ts`
  with identical signatures, both consumers (`mcp-handler.ts` +
  `scripts/check-parity.ts`) untouched. Verified zero behavioral diff:
  all 130 tool blocks byte-identical to original via brace-matching
  extraction. typecheck + lint + 157/157 tests + parity gate green.
  /sc:analyze 1 LOW (unnecessary `export` on internal `renderStoryMeta`)
  fixed. /sc:cleanup verdict = no further worthwhile cleanup. Copilot
  CLI APPROVED 1 pass (no findings). Wave 2.5 unblocked.
- **2026-04-30** — **Phase 2 Wave 2.4 shipped** (cloud v2.9.0). Profile,
  folders, and business writes: 26 non-destructive tools — folders
  (`create/edit/delete-folder`, `reorder-folders`, `toggle-folder-tags`),
  global-privacy write (`set-global-privacy-settings`), business profile
  (`create/edit/delete-business-chat-link`, `set-business-hours/location/
  greeting/away/intro`), profile (`set-emoji-status`, `clear-recent-
  emoji-statuses`, `set-profile-color`, `set-birthday`,
  `set-personal-channel`, `delete-profile-photo`, `update-profile`,
  `set-privacy`), and misc state-change (`set-auto-delete`, `add-contact`,
  `approve-join-request`, `activate-stealth-mode`). Premium/Business
  tiers handled via `premiumOnlyOnError` and `businessOnlyOnError`
  helpers — no separate opt-in flag, the daily quota covers abuse.
  `telegram-set-profile-photo` moved from `pending` to
  `EXPLICIT_EXCLUDED` (filesystem-bound, parity with `send-file/voice/
  video-note/album/story`). `telegram-clear-drafts` stays pending —
  upstream-DESTRUCTIVE, lands with Phase 2.1. Coverage: whitelist
  104 → 130 (~72%); baseline pending 63 → 36; `excluded 14 → 15`. 54
  new test cases in `tools-write-wave-2.4.test.ts`; 157/157 tests pass.
- **2026-04-30** — **Phase 2 Wave 2.3 shipped** (cloud v2.8.0). Chat
  admin / moderation: 14 non-destructive write tools — `kick-user`,
  `ban-user`, `unban-user`, `set-admin`, `remove-admin`, `archive-chat`,
  `pin-chat`, `mark-dialog-unread`, `set-slow-mode`, `toggle-anti-spam`,
  `toggle-prehistory-hidden`, `block-user`, `unblock-user`, `report-spam`.
  No opt-in flag — daily quota covers the abuse surface. Coverage:
  whitelist 90 → 104; baseline pending 77 → 63 (~57% of upstream's 181
  tools). `set-chat-permissions` is upstream-DESTRUCTIVE so it stays
  pending and lands with Phase 2.1 alongside the destructive opt-in
  plumbing.
- **2026-04-30** — **Roadmap decision lock-in** (no release tag — policy
  + docs only). Five planning decisions ratified into `ROADMAP.md` (full
  1:1 parity goal, Wave 2.3–2.7 + Phase 2.1 skeleton, Phase X deferred,
  Stars off-by-default in cloud image). `telegram-terminate-session`
  moved from `baseline.pending` to `EXPLICIT_EXCLUDED` as a permanent
  exclusion (security: prompt-injection blast radius across the user's
  *other* sessions — phone, desktop). `pending 78 → 77`,
  `excluded 13 → 14`; CI parity gate green at `90/14/77`.
- **2026-04-30** — **Phase 2 Wave 2.2 shipped** (cloud v2.7.0).
  Messaging core: 12 tools — `send-message`, `edit-message`,
  `forward-message`, `send-typing`, `send-location`, `send-venue`,
  `send-contact`, `send-dice`, `send-sticker`, `translate-message`,
  `get-unread-mentions`, `get-unread-reactions`. 5 filesystem-bound send
  tools (`send-file`, `send-voice`, `send-video-note`, `send-album`,
  `send-story`) moved to `EXPLICIT_EXCLUDED` — they require an absolute
  path on the cloud container filesystem, which the user does not
  control; deferred until a buffered/HTTPS-fetch upload path lands.
  Whitelist 78 → 90, baseline pending 95 → 78. Two tiny helpers added in
  `src/tools.ts`: `safeOpt` (sanitize an optional free-text field while
  preserving `undefined`) and `replyTargetFields` (shared
  `replyTo` + `topicId` zod fields used by the send-* tools — also
  normalized field descriptions across them).
- **2026-04-29** — **Phase 2 Wave 2.1 shipped** (cloud v2.6.0).
  First write batch: 8 tools — `send-reaction`, `set-default-reaction`,
  `send-paid-reaction`, `toggle-paid-reaction-privacy`, `react-to-story`,
  `save-draft`, `vote-poll`, `rate-transcription`. All low-risk (no
  destructive intent, no opt-in env flag). The data-driven array was
  renamed `READ_ONLY_TOOLS` → `TOOLS` and the public registration
  function `registerReadOnlyTools` → `registerAllAllowedTools` to
  reflect the broader catalog. New `WRITE` annotation tier added
  alongside the existing `READ_ONLY` and `SAFE_WRITE` tiers.
  Whitelist 70 → 78; baseline pending 103 → 95.
- **2026-04-29** — **Phase 2 Wave 1.3 shipped** (cloud v2.5.0). 14 new
  read-only tools: polling cursor (`get-state`, `get-updates`,
  `get-channel-updates`), fact-check, global privacy, groups-for-discussion,
  paid-reaction privacy, transcription poll, inline-query, list-emoji-statuses,
  group-calls (2, opt-in), quick-replies (2, opt-in). 6 Stars read-only
  tools intentionally deferred to Wave 3 with documented reason in
  `EXPLICIT_EXCLUDED`. Read-only parity 70/74 = 95% of upstream's RO tier.
  `ToolDefinition` gained a `requiresEnv` field so cloud can honestly gate
  opt-in upstream features (Group-calls, Quick-replies) at registration time.
- **2026-04-28** — **Phase 2.0.5 — `TOOL_REGISTRY` refactor** (cloud
  v2.4.0). 56 inline `server.registerTool()` blocks → data-driven
  `READ_ONLY_TOOLS` array + `registerAllTools` helper that wires
  cross-cutting concerns (rate-limit, connection-check, timing,
  error-mapping) in one place. `tools.ts` 2154 → 1381 lines (−29.5%).
  Each new tool now adds 10–30 lines instead of 30–60. Made Wave 2
  (93 write tools) tractable.
- **2026-04-28** — **Phase 2 Wave 1.1 + 1.2 shipped** (cloud v2.2.0
  + v2.3.0). 30 read-only tools added (15 + 15). Whitelist 26 → 56.
- **2026-04-28** — **Phase 2.0 — parity sync gate** shipped (cloud v2.1.0
  + upstream v1.36.0). Upstream now exports a `getToolManifest()` API
  via `@overpod/mcp-telegram/manifest` that introspects every tool the
  package can register, classifies each by risk tier (read-only / write /
  destructive), and forces opt-in env flags ON during introspection so
  the consumer sees the full catalog. Cloud added `pnpm check-parity`
  (CI-blocking) which compares the cloud whitelist against that catalog
  using `EXPLICIT_EXCLUDED` (intentional non-exposures with reasons) and
  a baseline file (`scripts/parity-baseline.json`) listing tools deferred
  to future expansion waves.
- **2026-04-28** — **Public release v2.0.0 — first public version**
  ([`5479ce0`](https://github.com/mcp-telegram/mcp-telegram-cloud/commit/5479ce0)).
- **2026-04-26** — README rewrite for public OSS, architecture.md OAuth
  refresh, SLA dashboard widgets in SigNoz, M1 (HttpOnly tg_user cookie)
  + M4 (templated public HTML — no upstream brand on self-hosted forks),
  Phase 4.5 SPDX header + npm `license: MIT`.
- **2026-04-25** — `LICENSE` + `CONTRIBUTING.md` + `CODE_OF_CONDUCT.md`
  + issue/PR templates, Phase 1 research (rate limits + proxy pool +
  OSS readiness audit), security-scan CI workflow (Gitleaks + TruffleHog
  on push/PR), broadcast bot live (`@mcp_telegram_cloud_bot`),
  rate-limiter event observability (cloud parser + upstream v1.35.0
  emitter).
- **2026-04-24** — Phase 0.5 fact-check audit closed (4 CRITICAL +
  8 HIGH + 5 MEDIUM resolved across an ENV centralisation wave),
  husky + gitleaks pre-commit hook, timing-safe ADMIN_TOKEN compare,
  PII hashing via `LOG_HASH_SALT`.

## How to contribute / influence the roadmap

- **Feature requests:** open an issue with the
  [`feature_request` template](.github/ISSUE_TEMPLATE/feature_request.yml).
  New MCP tools / MTProto coverage belong in the
  [upstream repo](https://github.com/mcp-telegram/mcp-telegram), not here —
  see [`CONTRIBUTING.md` §Project scope](CONTRIBUTING.md#project-scope).
- **Bug reports:** [`bug_report` template](.github/ISSUE_TEMPLATE/bug_report.yml).
- **Security issues:** see [`SECURITY.md`](SECURITY.md) — please don't
  use public issues.
- **Status / breaking-change notifications:** subscribe to
  [@mcp_telegram_cloud_bot](https://t.me/mcp_telegram_cloud_bot).
