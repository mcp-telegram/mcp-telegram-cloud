# Rate-limiter dashboard & alerts (Phase 0.2)

This doc captures the SigNoz queries and alert conditions for monitoring the rate-limiter event stream (`flood_wait`, `network_retry`, `temporary_retry`) emitted by `@overpod/mcp-telegram` >= 1.35.0 and forwarded by `src/rate-limiter-events.ts`.

The MCP server's SigNoz tool surface lets us query/aggregate logs and create dashboards programmatically, but **alerts must be configured manually in the UI** (or via SigNoz' file-based rules) — there's no `create_alert` API.

## Common log shape

Every captured event is a `WARN` log with these structured attributes:

| Attribute     | Type   | Values                                              |
|---------------|--------|-----------------------------------------------------|
| `component`   | string | always `rate-limiter`                               |
| `event`       | string | `flood_wait` \| `network_retry` \| `temporary_retry` |
| `context`     | string | SDK operation name (e.g. `list-chats`, truncated to 200 chars) |
| `attempt`     | number | retry attempt (1-indexed)                           |
| `maxRetries`  | number | total retries allowed                               |
| `seconds`     | number | optional, only for `flood_wait` (Telegram-mandated wait) |
| `delayMs`     | number | optional, only for `network_retry` / `temporary_retry` (our backoff) |
| `error`       | string | optional, last error message (truncated to 200 chars) |

Body format: `rate-limiter <event>` (e.g. `rate-limiter flood_wait`).

## Dashboard widgets

Add to existing dashboard **MCP Telegram Cloud** (UUID: `019cef83-4129-7bcd-b4ee-be5ed5c7a6ed`).

### W1 — Events per hour (time-series, stacked by `event`)

```
Source:    Logs
Filter:    service.name = "mcp-telegram-cloud" AND component = "rate-limiter"
Aggregate: count()
Group by:  event
Time agg:  rate per hour
Panel:     Time-series, stacked area
```

### W2 — Top 10 contexts (table)

```
Source:    Logs
Filter:    service.name = "mcp-telegram-cloud" AND component = "rate-limiter"
Aggregate: count()
Group by:  context, event
Order by:  count() desc
Limit:     10
Panel:     Table
```

Tells which SDK operations trigger the most retries — first signal that a method needs Layer 5 (per-method) protection.

### W3 — FLOOD_WAIT distribution by `seconds` (histogram)

```
Source:    Logs
Filter:    service.name = "mcp-telegram-cloud" AND component = "rate-limiter" AND event = "flood_wait"
Aggregate: count()
Group by:  seconds
Panel:     Histogram or bar chart
```

If `seconds` clusters near 60 (the GramJS auto-sleep threshold) — the SDK is burning the entire allowed sleep, suggesting load patterns we should rate-limit upstream.

### W4 — Recent events (list)

```
Source:    Logs
Filter:    service.name = "mcp-telegram-cloud" AND component = "rate-limiter"
Order by:  timestamp desc
Limit:     50
Panel:     Logs / list
Columns:   timestamp, event, context, seconds, delayMs, attempt, error
```

Free-text scrollable feed for quick inspection.

## Alerts

All alerts use **Logs** as the data source.

### A1 — flood_wait surge (WARN)

```
Condition:  count() of logs WHERE service.name = "mcp-telegram-cloud"
                              AND component = "rate-limiter"
                              AND event = "flood_wait"
            > 10 in the last 1 hour
Severity:   warning
Window:     1h, evaluate every 5 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: > 10 flood_wait/hour means we're hitting Telegram quotas regularly — reactive backoff still working but worth investigating which `context` is the culprit (drill down via W2).

### A2 — flood_wait spike (CRITICAL)

```
Condition:  count() of logs WHERE service.name = "mcp-telegram-cloud"
                              AND component = "rate-limiter"
                              AND event = "flood_wait"
            > 50 in the last 1 hour
Severity:   critical
Window:     1h, evaluate every 5 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: 50/hour is severe — likely a single user is scripting against our endpoint. Time to add Layer 3 (per-user burst) for this user, or block them.

### A3 — AUTH_KEY_DUPLICATED returns (CRITICAL)

```
Condition:  count() of logs WHERE service.name = "mcp-telegram-cloud"
                              AND body CONTAINS "AUTH_KEY_DUPLICATED"
            > 1 in the last 24 hours
Severity:   critical
Window:     24h, evaluate every 30 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: this was supposedly fixed by v1.27 IPC daemon. Resurgence means the IPC didn't catch a code path — investigate immediately.

### A4 — temporary_retry burst (WARN)

```
Condition:  count() of logs WHERE service.name = "mcp-telegram-cloud"
                              AND component = "rate-limiter"
                              AND event = "temporary_retry"
            > 20 in the last 1 hour
Severity:   warning
Window:     1h, evaluate every 5 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: 5xx / network error retries surging — Telegram-side incident or our DC routing issue.

## Sanity-check queries (for setup verification)

After adding widgets/alerts, run these via the SigNoz log explorer to confirm filters compile:

```
service.name = "mcp-telegram-cloud" AND component = "rate-limiter"
service.name = "mcp-telegram-cloud" AND component = "rate-limiter" AND event = "flood_wait"
service.name = "mcp-telegram-cloud" AND body CONTAINS "AUTH_KEY_DUPLICATED"
```

The first two should return 0 rows in the 24h baseline (no flood events yet — see `docs/research/telegram-rate-limits.md`). They're "armed" filters — empty result is correct, the alert fires when count > threshold.

## Threshold rationale

Numbers come from `docs/research/telegram-rate-limits.md` §6.4. They're conservative starts; revise after observing 4-6 weeks of real traffic at 50+ DAU.
