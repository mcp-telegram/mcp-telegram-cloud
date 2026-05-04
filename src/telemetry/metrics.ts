/**
 * Lightweight metrics layer (counters + histograms + gauges).
 *
 * Outbound destinations are gated by `config.telemetryMode`, identical to logger.ts:
 * - `on`        → in-memory snapshot for `/api/observability` + OTLP HTTP push to SigNoz (if `signozEndpoint` set)
 * - `local-only`→ in-memory snapshot only (default; **zero outbound**)
 * - `off`       → in-memory snapshot only; consistent with logger ring-buffer behavior
 *
 * Zero external dependencies — uses Node.js built-in fetch. Pattern mirrors logger.ts
 * so the privacy contract (telemetryMode kill-switch) extends to metrics by symmetry.
 *
 * Privacy: callers must not pass any blacklisted attributes (see telemetry/check-telemetry-core.ts).
 * Histogram/counter labels live in metric attributes and would be exported verbatim.
 */

import { config } from "../config.js";

const SERVICE_NAME = config.logServiceName;
const FLUSH_INTERVAL_MS = 15_000;
/** Outbound OTLP active only when telemetry is fully on AND endpoint is configured.
 * Re-evaluated on every flush (not captured at module load) so test stubs and
 * future hot-reload don't see a frozen gate — privacy kill-switch must respond
 * to the current `config` value, not a snapshot from boot. */
function otlpActive(): boolean {
  return config.telemetryMode === "on" && config.signozEndpoint !== "";
}

/** OTel-compatible histogram bucket boundaries (milliseconds). */
const HTTP_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];
const TOOL_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

type Labels = Record<string, string>;

interface CounterPoint {
  labels: Labels;
  value: number;
}

interface HistogramPoint {
  labels: Labels;
  count: number;
  sum: number;
  /** Cumulative bucket counts, aligned with `boundaries`. Length = boundaries.length + 1 (last is +Inf). */
  buckets: number[];
}

interface GaugeProvider {
  labels: Labels;
  read: () => number;
}

interface CounterDef {
  name: string;
  description: string;
  unit?: string;
  data: Map<string, CounterPoint>;
}

interface HistogramDef {
  name: string;
  description: string;
  unit?: string;
  boundaries: number[];
  data: Map<string, HistogramPoint>;
}

interface GaugeDef {
  name: string;
  description: string;
  unit?: string;
  providers: GaugeProvider[];
}

/** Stable label-key for map indexing. Sorted to make {a:1,b:2} === {b:2,a:1}. */
function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join("|");
}

/** Soft cardinality ceiling per metric series. SigNoz/ClickHouse handles much
 * more, but a leak past this almost always means a label is taking unbounded
 * user input. Logged once per metric to console.warn — no SigNoz outbound here
 * since metrics.ts must not depend on logger.ts (logger pulls from this). */
const CARDINALITY_WARN_THRESHOLD = 1000;
const cardinalityWarned = new Set<string>();
function checkCardinality(metricName: string, size: number): void {
  if (size > CARDINALITY_WARN_THRESHOLD && !cardinalityWarned.has(metricName)) {
    cardinalityWarned.add(metricName);
    console.warn(
      `[metrics] series cardinality ${size} > ${CARDINALITY_WARN_THRESHOLD} for "${metricName}" — check label allow-list`,
    );
  }
}

const counters = new Map<string, CounterDef>();
const histograms = new Map<string, HistogramDef>();
const gauges = new Map<string, GaugeDef>();

function counter(name: string, description: string, unit?: string): CounterDef {
  let def = counters.get(name);
  if (!def) {
    def = { name, description, ...(unit !== undefined && { unit }), data: new Map() };
    counters.set(name, def);
  }
  return def;
}

function histogram(name: string, description: string, boundaries: number[], unit?: string): HistogramDef {
  let def = histograms.get(name);
  if (!def) {
    def = { name, description, ...(unit !== undefined && { unit }), boundaries, data: new Map() };
    histograms.set(name, def);
  }
  return def;
}

/** Pre-declared metric definitions. Centralized so `/api/observability` can render
 * a stable schema and so check-telemetry can assert the label allow-list. */
export const HTTP_REQUESTS = counter("http.requests", "HTTP requests served", "1");
export const HTTP_DURATION = histogram("http.duration", "HTTP request duration", HTTP_BUCKETS_MS, "ms");
export const TOOL_CALLS = counter("mcp.tool.calls", "MCP tool calls (post-handler)", "1");
export const TOOL_DURATION = histogram("mcp.tool.duration", "MCP tool handler duration", TOOL_BUCKETS_MS, "ms");
export const OAUTH_FLOW = counter("oauth.flow", "OAuth flow step outcomes", "1");
export const RATE_LIMIT_HITS = counter("rate_limit.hits", "Rate-limit denials by tier", "1");

export function incr(def: CounterDef, labels: Labels = {}, by: number = 1): void {
  const key = labelKey(labels);
  const existing = def.data.get(key);
  if (existing) {
    existing.value += by;
  } else {
    def.data.set(key, { labels: { ...labels }, value: by });
    checkCardinality(def.name, def.data.size);
  }
}

export function observe(def: HistogramDef, value: number, labels: Labels = {}): void {
  const key = labelKey(labels);
  let point = def.data.get(key);
  if (!point) {
    point = {
      labels: { ...labels },
      count: 0,
      sum: 0,
      buckets: new Array(def.boundaries.length + 1).fill(0),
    };
    def.data.set(key, point);
    checkCardinality(def.name, def.data.size);
  }
  point.count += 1;
  point.sum += value;
  let placed = false;
  for (let i = 0; i < def.boundaries.length; i++) {
    if (value <= def.boundaries[i]) {
      point.buckets[i] += 1;
      placed = true;
      break;
    }
  }
  if (!placed) point.buckets[def.boundaries.length] += 1;
}

/** Read all gauge providers once. Each provider is invoked exactly once per call;
 * a single `snapshot()` or `buildOtlpPayload()` shows internally-consistent values.
 * Providers throwing → 0 (so `/api/observability` never 500s on a broken gauge). */
function readGaugePoints(def: GaugeDef): Array<{ labels: Labels; value: number }> {
  return def.providers.map((p) => {
    try {
      return { labels: p.labels, value: p.read() };
    } catch {
      return { labels: p.labels, value: 0 };
    }
  });
}

/** Register a gauge with a value-provider callback. Provider runs once per
 * `snapshot()` and once per `flushMetrics()`. Two `/api/observability` page
 * renders ≈ 2 reads; a flush mid-render can produce a 3rd. Keep providers
 * cheap and side-effect-free (e.g. SQL `COUNT(*)` is fine, opening a connection
 * is not). */
export function registerGauge(
  name: string,
  description: string,
  read: () => number,
  labels: Labels = {},
  unit?: string,
): void {
  let def = gauges.get(name);
  if (!def) {
    def = { name, description, ...(unit !== undefined && { unit }), providers: [] };
    gauges.set(name, def);
  }
  def.providers.push({ labels: { ...labels }, read });
}

/** Snapshot the current state for `/api/observability`. Cumulative — not reset. */
export function snapshot(): {
  counters: Array<{ name: string; description: string; points: CounterPoint[] }>;
  histograms: Array<{
    name: string;
    description: string;
    boundaries: number[];
    points: HistogramPoint[];
  }>;
  gauges: Array<{ name: string; description: string; points: Array<{ labels: Labels; value: number }> }>;
} {
  return {
    counters: Array.from(counters.values()).map((d) => ({
      name: d.name,
      description: d.description,
      points: Array.from(d.data.values()),
    })),
    histograms: Array.from(histograms.values()).map((d) => ({
      name: d.name,
      description: d.description,
      boundaries: d.boundaries,
      points: Array.from(d.data.values()),
    })),
    gauges: Array.from(gauges.values()).map((d) => ({
      name: d.name,
      description: d.description,
      points: readGaugePoints(d),
    })),
  };
}

interface OtlpKv {
  key: string;
  value: { stringValue: string };
}

function toAttrs(labels: Labels): OtlpKv[] {
  return Object.entries(labels).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

interface OtlpDataPoint {
  attributes: OtlpKv[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt?: string;
  asDouble?: number;
  count?: string;
  sum?: number;
  bucketCounts?: string[];
  explicitBounds?: number[];
}

interface OtlpMetric {
  name: string;
  description: string;
  unit?: string;
  sum?: { dataPoints: OtlpDataPoint[]; aggregationTemporality: 2; isMonotonic: boolean };
  histogram?: { dataPoints: OtlpDataPoint[]; aggregationTemporality: 2 };
  gauge?: { dataPoints: OtlpDataPoint[] };
}

const startTimeNs = String(Date.now() * 1_000_000);

function buildOtlpPayload(): {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKv[] };
    scopeMetrics: Array<{ scope: { name: string }; metrics: OtlpMetric[] }>;
  }>;
} {
  const nowNs = String(Date.now() * 1_000_000);
  const metrics: OtlpMetric[] = [];

  for (const def of counters.values()) {
    if (def.data.size === 0) continue;
    metrics.push({
      name: def.name,
      description: def.description,
      ...(def.unit !== undefined && { unit: def.unit }),
      sum: {
        dataPoints: Array.from(def.data.values()).map((p) => ({
          attributes: toAttrs(p.labels),
          startTimeUnixNano: startTimeNs,
          timeUnixNano: nowNs,
          asInt: String(p.value),
        })),
        aggregationTemporality: 2,
        isMonotonic: true,
      },
    });
  }

  for (const def of histograms.values()) {
    if (def.data.size === 0) continue;
    metrics.push({
      name: def.name,
      description: def.description,
      ...(def.unit !== undefined && { unit: def.unit }),
      histogram: {
        dataPoints: Array.from(def.data.values()).map((p) => ({
          attributes: toAttrs(p.labels),
          startTimeUnixNano: startTimeNs,
          timeUnixNano: nowNs,
          count: String(p.count),
          sum: p.sum,
          bucketCounts: p.buckets.map(String),
          explicitBounds: def.boundaries,
        })),
        aggregationTemporality: 2,
      },
    });
  }

  for (const def of gauges.values()) {
    if (def.providers.length === 0) continue;
    metrics.push({
      name: def.name,
      description: def.description,
      ...(def.unit !== undefined && { unit: def.unit }),
      gauge: {
        dataPoints: readGaugePoints(def).map((p) => ({
          attributes: toAttrs(p.labels),
          startTimeUnixNano: startTimeNs,
          timeUnixNano: nowNs,
          asDouble: p.value,
        })),
      },
    });
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }] },
        scopeMetrics: [{ scope: { name: SERVICE_NAME }, metrics }],
      },
    ],
  };
}

let flushTimer: ReturnType<typeof setInterval> | null = null;
/** Tracks the currently-running export. Concurrent callers (timer tick during a slow
 * SigNoz POST, or SIGTERM during the same window) await the same promise — single
 * outbound request per cycle, no overlap, no tail-loss on shutdown. */
let inFlight: Promise<void> | null = null;

async function doFlush(): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // signozAuth read dynamically alongside signozEndpoint (post-H1 fix pattern); format
  // `"user:password"`, empty disables the Authorization header.
  if (config.signozAuth) {
    headers.Authorization = `Basic ${Buffer.from(config.signozAuth).toString("base64")}`;
  }
  try {
    await fetch(`${config.signozEndpoint}/v1/metrics`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildOtlpPayload()),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silent fail — don't crash app if SigNoz is down. Cumulative state preserved
    // so next flush re-sends the latest values; backend dedupes via timestamp.
  }
}

export async function flushMetrics(): Promise<void> {
  if (!otlpActive()) return;
  // If a flush is already running, await its completion — guarantees the SIGTERM
  // shutdown path drains the tail even when it lands mid-export.
  if (inFlight) return inFlight;
  const hasData =
    Array.from(counters.values()).some((d) => d.data.size > 0) ||
    Array.from(histograms.values()).some((d) => d.data.size > 0) ||
    Array.from(gauges.values()).some((d) => d.providers.length > 0);
  if (!hasData) return;

  inFlight = doFlush().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Start the periodic flush timer. Idempotent — safe to call once at boot. */
export function startMetricsFlush(): void {
  if (flushTimer) return;
  if (!otlpActive()) return;
  flushTimer = setInterval(() => {
    // Drop the promise explicitly: any rejection inside flushMetrics is already
    // swallowed by its inner try/finally, but `void` silences the linter and
    // makes the intent obvious — interval ticks must not crash the timer.
    void flushMetrics();
  }, FLUSH_INTERVAL_MS);
}

/** Stop the timer. Used by graceful shutdown so the process can exit. */
export function stopMetricsFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/** Test-only: drop all registered counters/histograms/gauges. */
export function _resetMetricsForTest(): void {
  counters.clear();
  histograms.clear();
  gauges.clear();
  // Re-register the canonical defs so tests can `incr(HTTP_REQUESTS, ...)` without re-importing.
  counters.set(HTTP_REQUESTS.name, HTTP_REQUESTS);
  counters.set(TOOL_CALLS.name, TOOL_CALLS);
  counters.set(OAUTH_FLOW.name, OAUTH_FLOW);
  counters.set(RATE_LIMIT_HITS.name, RATE_LIMIT_HITS);
  histograms.set(HTTP_DURATION.name, HTTP_DURATION);
  histograms.set(TOOL_DURATION.name, TOOL_DURATION);
  HTTP_REQUESTS.data.clear();
  TOOL_CALLS.data.clear();
  OAUTH_FLOW.data.clear();
  RATE_LIMIT_HITS.data.clear();
  HTTP_DURATION.data.clear();
  TOOL_DURATION.data.clear();
  cardinalityWarned.clear();
  inFlight = null;
}
