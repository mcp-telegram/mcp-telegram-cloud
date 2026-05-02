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

Add to your SigNoz dashboard for the cloud service. Self-hosters: create a dashboard, replace UUIDs in API calls below with your own.

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

The first two should return 0 rows in the 24h baseline (no flood events yet on a low-traffic deploy). They're "armed" filters — empty result is correct, the alert fires when count > threshold.

## End-to-end verification

A first end-to-end check was run in production on 2026-04-26: synthetic `flood_wait` / `network_retry` / `temporary_retry` lines were emitted from inside the cloud container, and three matching WARN records (with `component=rate-limiter`, `event=…`, `service.name=mcp-telegram-cloud`) appeared in SigNoz.

### Scope of this check

This procedure validates the **cloud-side** half of the pipeline only:

```
console.error → cloud parser → logger.warn → OTLP → SigNoz
```

It does **not** exercise the real `@overpod/mcp-telegram` rate-limiter, so it does not prove the upstream `mcp-telegram → console.error` hop. That hop is covered by unit tests in `mcp-telegram` plus the contract documented in [Common log shape](#common-log-shape); a real flood event in production will be the first true end-to-end signal.

### Reproduction command

Pick exactly one replica (the service is currently single-replica; running this against multiple replicas multiplies the synthetic-event count in shared SigNoz queries and dashboards):

```sh
CID=$(docker ps --filter name=mcp-telegram_cloud --format '{{.ID}}' | head -n 1)
docker exec "$CID" node -e '
  (async () => {
    const m = await import("./dist/rate-limiter-events.js");
    const { logger } = await import("./dist/logger.js");
    m.installRateLimiterEventListener();
    console.error("[rate-limiter] event " + JSON.stringify({event:"flood_wait",context:"e2e_verification",attempt:1,maxRetries:3,seconds:5}));
    console.error("[rate-limiter] event " + JSON.stringify({event:"network_retry",context:"e2e_verification",attempt:1,maxRetries:3,delayMs:1000,error:"ECONNRESET"}));
    console.error("[rate-limiter] event " + JSON.stringify({event:"temporary_retry",context:"e2e_verification",attempt:2,maxRetries:3,delayMs:500}));
    await logger.flush();
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });'
```

`logger.flush()` is awaited explicitly, so the process exits only after the OTLP POST completes — no batch-interval timing assumptions. The matching SigNoz query is `component = 'rate-limiter' AND context = 'e2e_verification'`.

### Expected result

Three WARN records within a few seconds, all carrying `service.name=mcp-telegram-cloud`, `component=rate-limiter`, `severity_text=WARN`, and the expected `event` value. Filter `context=e2e_verification` out of production analytics or run the check during a low-traffic window. Re-run whenever the parser, logger, or OTLP plumbing changes.

## Threshold rationale

Conservative starting thresholds; revise after observing 4-6 weeks of real traffic at 50+ DAU.
