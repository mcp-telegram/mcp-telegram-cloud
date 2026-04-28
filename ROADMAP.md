# Roadmap

Public roadmap for `mcp-telegram-cloud`. This is a **living document** — items move,
priorities shift, dates are not promises. Maintained by one person in spare time
(see [README §Maintenance](README.md#maintenance)).

For the internal, fact-check-audited working plan with risks and exit criteria, see
[`claudedocs/workflow_cloud_open_source.md`](claudedocs/workflow_cloud_open_source.md).

**Last updated:** 2026-04-28
**Current version:** 2.4.0 (cloud — TOOL_REGISTRY refactor) / [`@overpod/mcp-telegram` 1.36.0](https://github.com/mcp-telegram/mcp-telegram) (upstream)

---

## Now (in flight)

Things actively being worked on or about to ship.

- **Tool whitelist expansion — Wave 1 (read-only)** (Phase 2). The
  [parity sync gate](claudedocs/workflow_cloud_open_source.md#20-parity-sync-mechanism-foundational--делается-первым)
  is live: `pnpm check-parity` compares the cloud whitelist against the
  upstream tool catalog (via [`@overpod/mcp-telegram/manifest`](https://www.npmjs.com/package/@overpod/mcp-telegram))
  and CI blocks merges that introduce drift. Wave 1 = read-only catalog
  expansion (`get-*` / `list-*` / `search-*` / `read-*` / `download-*`)
  drawn from `scripts/parity-baseline.json`, no new safety gates needed
  since the existing per-user daily quota already covers them.
- **Observability hardening** — external uptime monitoring + manual SigNoz
  alerts (8 rules: 4 rate-limiter, 4 SLA). Dashboards already live;
  alert delivery via Telegram bot to admin remains. Phase 0.2 tail.

## Next (planned, not started)

Things planned with known scope. Order is approximate and may change.

- **Tool whitelist expansion — Wave 2 (state-change low-risk)** — folders
  write, profile write, privacy, contacts add/block/unblock, draft mgmt,
  reactions, votes. No opt-in flag needed — existing daily quota covers
  the abuse surface for these.
- **Tool whitelist expansion — Wave 3 (destructive opt-in)** — send/edit/
  delete messages, stories write, chat admin (ban/kick/permissions),
  groups lifecycle, business write, paid reactions. Gated by per-user
  `enable_destructive_tools` flag + audit log + tighter daily limit
  (separate counter from the baseline quota). Settings UI at
  `/settings` + audit visibility at `/my/audit`.
- **Per-user burst rate limit** (Layer 3 from the
  [layered approach in `docs/research/telegram-rate-limits.md`](docs/research/telegram-rate-limits.md#61-layered-approach)) —
  trigger: ≥10 daily active users sustained 7 days. Currently
  Layer 1 (per-IP HTTP rate-limit on `/oauth/*`, 30 req/min) and Layer 2
  (per-user daily quota, default 100 calls/day via `FREE_TIER_LIMIT`) are
  live; Layer 5 (per-method soft limits) only if real flood statistics
  demand it.

## Later (likely, no commitment)

Direction is set, but timing depends on usage signals or external events.

- **Proxy pool** — currently single-IP. Activation is investigation-led,
  not automatic — see
  [`docs/research/proxy-pool-strategy.md` §3 Triggers](docs/research/proxy-pool-strategy.md).
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
[changelog](claudedocs/workflow_cloud_open_source.md#changelog).

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

## Done (recent highlights)

For full history see
[`claudedocs/workflow_cloud_open_source.md` §Changelog](claudedocs/workflow_cloud_open_source.md#changelog).

- **2026-04-28** — **Phase 2.0 — parity sync gate** shipped (cloud v2.1.0
  + upstream v1.36.0). Upstream now exports a `getToolManifest()` API
  via `@overpod/mcp-telegram/manifest` that introspects every tool the
  package can register, classifies each by risk tier (read-only / write /
  destructive), and forces opt-in env flags ON during introspection so
  the consumer sees the full catalog. Cloud added `pnpm check-parity`
  (CI-blocking) which compares the cloud whitelist against that catalog
  using `EXPLICIT_EXCLUDED` (intentional non-exposures with reasons) and
  a baseline file (`scripts/parity-baseline.json`) listing tools deferred
  to future expansion waves. Wave 1 (read-only) can now begin without
  drift risk — every upstream addition needs an explicit decision.
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
