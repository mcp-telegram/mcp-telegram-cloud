# SLA & HTTP Health dashboard (Phase 0.2)

This doc captures the SigNoz queries and alert conditions for the **SLA & HTTP Health** section of the cloud dashboard. It complements [rate-limiter-dashboard.md](./rate-limiter-dashboard.md) which focuses on Telegram-side retries; this doc focuses on the cloud HTTP surface (`/mcp`, `/oauth/*`, public pages). Self-hosters: queries below assume `service.name="mcp-telegram-cloud"`; replace if you change `LOG_SERVICE_NAME`.

The SigNoz MCP tool surface lets us query/aggregate logs and update dashboards programmatically, but **alerts must be configured manually in the UI** (or via SigNoz' file-based rules) — there's no `create_alert` API.

## Common log shape

Every captured access-log entry is emitted by [src/middleware/access-log.ts](../../src/middleware/access-log.ts) with these structured attributes:

| Attribute    | Wire type | Values                                                           |
|--------------|-----------|------------------------------------------------------------------|
| `component`  | string    | always `http`                                                    |
| `event`      | string    | always `http.request`                                            |
| `method`     | string    | HTTP method (`GET`, `POST`, `OPTIONS`, …)                        |
| `path`       | string    | request path (raw, no normalisation)                             |
| `status`     | string    | HTTP status code as a string (e.g. `"200"`, `"404"`, `"500"`)    |
| `durationMs` | string    | server-side latency in ms (excludes upstream Traefik time)       |
| `client`     | string    | classified UA bucket: `chatgpt` / `claude` / `browser` / `bot` / `script` / `empty` / `other` |

**Type note (important):** [src/middleware/access-log.ts](../../src/middleware/access-log.ts) sets `status: String(status)` and `durationMs: duration` (number), and [src/logger.ts](../../src/logger.ts) `toAttributes()` coerces every value via `String(value)` into OTLP `stringValue`. So on the wire both `status` and `durationMs` are strings. SigNoz' query layer transparently coerces these to numbers for comparison/percentile operators (verified empirically — `status = 404` and `status = '404'` return identical counts, `p95(durationMs)` returns ms), so the numeric filter expressions in this doc work as written. If a future logger refactor types these fields differently, re-verify the queries.

Body format: `{method} {path} {status} {durationMs}ms [{client}]` (e.g. `GET /privacy 200 10ms [script]`).

`/health` and `/icon.svg` are **not logged** — they would dominate volume from external pings and offer no SLA signal.

`severity_text` mapping: `status >= 500 → ERROR`, `status >= 400 → WARN`, `status < 400 → INFO`.

## Dashboard widgets

All widgets live under the **SLA & HTTP Health** row in the existing dashboard.

### S1 — 5xx Error Rate (value, percentunit)

```
Source:    Logs
A (disabled): count() WHERE component = 'http' AND status >= 500
B (disabled): count() WHERE component = 'http' AND status < 500
Formula:   F1 = A / (A+B)
Panel:     Value, yAxisUnit = percentunit
```

Dominant SLA indicator. Target: < 1% (matches plan §Success Metrics).

### S2 — 4xx+5xx Error Rate (value, percentunit)

```
Source:    Logs
A (disabled): count() WHERE component = 'http' AND status >= 400
B (disabled): count() WHERE component = 'http' AND status < 400
Formula:   F1 = A / (A+B)
Panel:     Value, yAxisUnit = percentunit
```

Wider blast-radius: includes 401/403 (auth churn from probes) and 404 (scanners). Useful to spot if auth flow is broken — sudden 401 spike on `/oauth/*` shows here before 5xx.

### S3 — HTTP Latency p95 (value, ms)

```
Source:    Logs
Filter:    component = 'http'
Aggregate: p95(durationMs)
Panel:     Value, yAxisUnit = ms
```

Plan §Success Metrics targets are stated for **p50** (`< 500ms`) and **p99** (`< 3s`) and explicitly scoped to `/mcp`. p95 is shown here as a complementary middle-ground signal that catches degradations earlier than p99 without being noise-dominated like raw averages. **Scope deviation:** this widget covers **all** HTTP traffic (`component = 'http'`), not only `/mcp`, because at current traffic volume `/mcp` is intermittent and a `/mcp`-only percentile is undefined for most buckets. The whole-surface percentile dilutes `/mcp` regressions with cheap static-page hits — when `/mcp` traffic stabilises, add a `path = '/mcp'` filtered companion widget. Treat S3 as observation-only until a p95 target is added to the plan.

### S4 — HTTP Latency p99 (value, ms)

```
Source:    Logs
Filter:    component = 'http'
Aggregate: p99(durationMs)
Panel:     Value, yAxisUnit = ms
```

Plan target: **p99 < 3s**, alarm at `> 10s`. Same scope deviation as S3 — measured across all HTTP routes, not just `/mcp`. Catches tail-latency regressions invisible to p50.

### S5 — HTTP Latency p50 / p95 / p99 (graph, ms)

```
Source:    Logs
Filter:    component = 'http'
Three series: A=p50, B=p95, C=p99 (each grouped by nothing; series via separate queries)
Panel:     Time-series graph
```

Trend view for the same percentile triple, same all-routes scope as S3/S4 — useful for catching gradual drift (e.g. SQLite getting slower as `usage_log` grows before retention kicks in).

### S6 — Requests by status code (graph, stacked)

```
Source:    Logs
Filter:    component = 'http'
Aggregate: count()
Group by:  status
Panel:     Stacked time-series
```

Visual baseline of request mix. Note: `status` is the exact HTTP code (`200`, `401`, `404`, `500`), not a 2xx/4xx/5xx class — the access-log middleware emits exact codes and the dashboard does not bucket them. Each code becomes its own series, which is fine for typical mixes (a handful of dominant codes) but gets noisy if many distinct error codes appear. If that happens, switch to grouping by `severity_text` (which logger.ts maps to `INFO`/`WARN`/`ERROR` from the same status thresholds) for a true class view. Sudden colour shift = something changed (deploy, scanner wave, ChatGPT auth churn).

### S7 — Top error paths (table)

```
Source:    Logs
Filter:    component = 'http' AND status >= 400
Aggregate: count() as 'Errors'
Group by:  path, status, method
Order by:  count() desc
Limit:     20
Panel:     Table
```

The drill-down for S2: which paths trigger 4xx/5xx most often. Most rows will be 404s on bot-scanned paths (`/wp-admin`, `/.env`); real signal is when `/mcp`, `/oauth/*`, or `/login` show up.

## Alerts

All alerts use **Logs** as the data source. Thresholds align with plan §Success Metrics.

### A5 — 5xx error rate (CRITICAL)

```
Condition:  count() of logs WHERE component = 'http' AND status >= 500
            > 5 in the last 1 hour
Severity:   critical
Window:     1h, evaluate every 5 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: any sustained 5xx is a real bug or infra issue. Target SLA is < 1% — at typical 50-100 req/h baseline that's < 1 expected event/h.

### A6 — Error rate ratio (WARN)

```
Source:     Logs (use a formula query — SigNoz Builder rule: A and B disabled, F1 = A/(A+B))
A (disabled): count() WHERE component = 'http' AND status >= 500
B (disabled): count() WHERE component = 'http' AND status < 500
Formula:    F1 = A / (A+B)
Condition:  F1 > 0.05 in the last 1 hour
Severity:   warning
Window:     1h, evaluate every 5 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: 5% threshold from plan §Success Metrics ("> 5% за 1h"). Catches storms even when absolute count is small. The widget S1 already uses this exact A/B/F1 shape — clone it when wiring the alert in the SigNoz UI to avoid hand-rolling the ratio.

### A7 — Latency p99 spike (WARN)

```
Condition:  p99(durationMs) WHERE component = 'http'
            > 10000 (10s) in the last 30 min
Severity:   warning
Window:     30m, evaluate every 5 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: plan target is p99 < 3s; alert fires at the "alarm" threshold of 10s. Excludes happy-path baselines (~30ms p95 in 7d window).

### A8 — Latency p95 sustained (WARN)

```
Condition:  p95(durationMs) WHERE component = 'http'
            > 2000 (2s) in the last 30 min
Severity:   warning
Window:     30m, evaluate every 5 min
Channel:    Telegram broadcast bot (admin chat)
```

Rationale: plan §Success Metrics defines `p50 < 500ms` (target) and `p50 > 2s` (alarm). We monitor the `2s` alarm threshold against **p95** instead of p50 because at low traffic (< 50 DAU) p50 is dominated by static-page hits and rarely moves; p95 is sensitive enough to catch DB / IPC / GramJS degradations before users notice. p99 spike alone (A7) can be a single bad request; sustained p95 means broader degradation. Re-evaluate at 50+ DAU when the plan's `/mcp` p50 target becomes statistically meaningful.

## Sanity-check queries (for setup verification)

After adding widgets/alerts, run these via the SigNoz log explorer (or the `signoz_aggregate_logs` MCP tool) to confirm filters compile:

```
service.name = 'mcp-telegram-cloud' AND component = 'http'
service.name = 'mcp-telegram-cloud' AND component = 'http' AND status >= 500
service.name = 'mcp-telegram-cloud' AND component = 'http' AND status >= 400 AND status < 500
```

Expected at the time of adding (24h baseline, low-traffic deployment): 5xx = 0, 4xx ≈ scanner volume (mostly `/wp-admin`, `/.git`, `/.env`), 2xx/3xx = legitimate traffic. Compare numbers between widgets and ad-hoc queries to confirm the dashboard query builder didn't drop a filter.

## Threshold rationale

Conservative starting thresholds; revise after observing 4-6 weeks of real traffic at 50+ DAU. All thresholds assume single-replica deploy — if scaling out, divide rate-based thresholds by replica count or aggregate before alerting.

## Scope of this doc

This dashboard tracks **cloud HTTP responses** only. It does **not** measure:

- Real user-perceived latency (Traefik time, network RTT) — needs external uptime monitoring (UptimeRobot or similar, see plan §0.2).
- MCP tool execution time inside `/mcp` — those events live as `event = 'tool.duration'` and are captured by the existing `Tool Latency` widget.
- Telegram-side retries — see [rate-limiter-dashboard.md](./rate-limiter-dashboard.md).

Together with the rate-limiter and tool widgets, this gives the three layers needed: external (uptime monitor, pending), HTTP surface (this doc), Telegram surface (rate-limiter doc).
