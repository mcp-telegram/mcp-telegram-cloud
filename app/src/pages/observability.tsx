import type { CSSProperties } from "react";
import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss, tg } from "../theme.js";

export type TelemetryMode = "on" | "local-only" | "off";

export type ObservabilityProps = {
  locale: string;
  telemetryMode: TelemetryMode;
  signozEndpointConfigured: boolean;
  daily: { date: string; count: number }[];
  dau: { date: string; activeUsers: number }[];
  clients: { client: string; totalCalls: number; uniqueUsers: number }[];
  topUsers: { userId: string; totalCalls: number }[];
  recentErrors: { timestamp: string; message: string; attrs: Record<string, string> }[];
  metrics: MetricsSnapshot;
  spans: SpanRow[];
  /** Hashed island bundle URLs from the Vite client manifest. */
  scripts?: readonly string[];
};

/** Metric point shapes — kept structurally identical to the backend snapshot so
 * the route can hand the value straight through without remapping. */
type MetricPoint = { labels: Record<string, string>; value: number };
type CounterPoint = MetricPoint;
type HistogramPoint = { labels: Record<string, string>; count: number; buckets: number[] };
export type MetricsSnapshot = {
  gauges: { name: string; points: MetricPoint[] }[];
  counters: { name: string; points: CounterPoint[] }[];
  histograms: { name: string; boundaries: number[]; points: HistogramPoint[] }[];
};
export type SpanRow = {
  name: string;
  traceId: string;
  durationMs: number;
  /** OTLP status code: 2 = ERROR, 1 = OK, 0 = unset. */
  statusCode: number;
  attrs: Record<string, string>;
};

const modeColors: Record<TelemetryMode, { bg: string; fg: string }> = {
  on: { bg: "#2ea043", fg: "#fff" },
  "local-only": { bg: "#0969da", fg: "#fff" },
  off: { bg: "#6e7781", fg: "#fff" },
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const numCell: CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
const emptyStyle: CSSProperties = { color: tg.hint, fontSize: 13, padding: "12px 0", textAlign: "center" };
const sectionH2: CSSProperties = {
  fontSize: 16,
  margin: "0 0 8px 0",
  textTransform: "none",
  letterSpacing: 0,
  color: tg.text,
};
const noteStyle: CSSProperties = { color: "#888", fontSize: 12, margin: "0 0 8px 0" };
const monoCell: CSSProperties = {
  fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
};

function fmtAttrs(attrs: Record<string, string>): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${v}`).join(" ");
}

function fmtLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k}=${v}`).join(" ");
}

/** Linear interpolation across cumulative buckets to estimate a quantile (e.g. p95).
 * Returns "—" when count=0 or buckets are empty (process just started). */
function quantileMs(boundaries: number[], buckets: number[], totalCount: number, q: number): string {
  if (totalCount === 0) return "—";
  const target = totalCount * q;
  let cumulative = 0;
  for (let i = 0; i < boundaries.length; i++) {
    cumulative += buckets[i] ?? 0;
    if (cumulative >= target) return `${boundaries[i]}`;
  }
  return `>${boundaries[boundaries.length - 1]}`;
}

function ObservabilityPage(props: ObservabilityProps) {
  const {
    locale,
    telemetryMode,
    signozEndpointConfigured,
    daily,
    dau,
    clients,
    topUsers,
    recentErrors,
    metrics,
    spans,
  } = props;
  const t = createTranslator(getMessages(locale));
  const c = modeColors[telemetryMode];
  const hasCounters = metrics.counters.some((cnt) => cnt.points.length > 0);
  const hasHistograms = metrics.histograms.some((h) => h.points.length > 0);

  return (
    <Layout
      locale={locale}
      title={`${t("observability.title")} — Admin`}
      description={t("observability.subtitle")}
      scripts={props.scripts}
      css={baseCss}
    >
      <main className="card" style={{ maxWidth: 1024, textAlign: "start" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <h1>{t("observability.title")}</h1>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </header>
        <p className="muted" style={{ marginTop: 4 }}>
          {t("observability.telemetryMode")}:{" "}
          <span
            style={{
              display: "inline-block",
              padding: "2px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              background: c.bg,
              color: c.fg,
            }}
          >
            {telemetryMode}
          </span>
          {telemetryMode === "on" && !signozEndpointConfigured && (
            <span style={{ color: tg.destructive, marginInlineStart: 8, fontSize: 12 }}>
              {t("observability.signozWarning")}
            </span>
          )}
        </p>

        <section style={{ marginTop: 24 }}>
          <h2 style={sectionH2}>{t("observability.dailyHeading")}</h2>
          {daily.length === 0 ? (
            <div style={emptyStyle}>{t("observability.dailyEmpty")}</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th>{t("observability.colDate")}</th>
                  <th style={{ textAlign: "right" }}>{t("observability.colCalls")}</th>
                  <th style={{ textAlign: "right" }}>{t("observability.colActiveUsers")}</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => {
                  const dauRow = dau.find((x) => x.date === d.date);
                  return (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td style={numCell}>{d.count}</td>
                      <td style={numCell}>{dauRow?.activeUsers ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section
          style={{
            marginTop: 24,
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 16,
          }}
        >
          <div>
            <h2 style={sectionH2}>{t("observability.byClientHeading")}</h2>
            {clients.length === 0 ? (
              <div style={emptyStyle}>{t("observability.byClientEmpty")}</div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th>{t("observability.colClient")}</th>
                    <th style={{ textAlign: "right" }}>{t("observability.colCalls")}</th>
                    <th style={{ textAlign: "right" }}>{t("observability.colUsers")}</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((cl) => (
                    <tr key={cl.client}>
                      <td>{cl.client}</td>
                      <td style={numCell}>{cl.totalCalls}</td>
                      <td style={numCell}>{cl.uniqueUsers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h2 style={sectionH2}>{t("observability.topUsersHeading")}</h2>
            {topUsers.length === 0 ? (
              <div style={emptyStyle}>{t("observability.topUsersEmpty")}</div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th>{t("observability.colUserId")}</th>
                    <th style={{ textAlign: "right" }}>{t("observability.colCalls")}</th>
                  </tr>
                </thead>
                <tbody>
                  {topUsers.map((u) => (
                    <tr key={u.userId}>
                      <td>{u.userId}</td>
                      <td style={numCell}>{u.totalCalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section style={{ marginTop: 24 }}>
          <h2 style={sectionH2}>
            {t("observability.errorsHeading")} ({recentErrors.length})
          </h2>
          {recentErrors.length === 0 ? (
            <div style={emptyStyle}>{t("observability.errorsEmpty")}</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th>{t("observability.colTimeUtc")}</th>
                  <th>{t("observability.colMessageAttrs")}</th>
                </tr>
              </thead>
              <tbody>
                {recentErrors.map((e) => (
                  <tr key={`${e.timestamp}-${e.message}`}>
                    <td style={{ whiteSpace: "nowrap", fontSize: 11 }}>{e.timestamp.replace("T", " ").slice(0, 19)}</td>
                    <td>
                      <div style={{ ...monoCell, fontSize: 12, wordBreak: "break-word" }}>{e.message}</div>
                      {Object.keys(e.attrs).length > 0 && (
                        <div
                          style={{ ...monoCell, color: tg.hint, fontSize: 11, wordBreak: "break-all", marginTop: 2 }}
                        >
                          {fmtAttrs(e.attrs)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section style={{ marginTop: 24 }}>
          <h2 style={sectionH2}>
            {t("observability.tracesHeading")} ({spans.length})
          </h2>
          <p style={noteStyle}>{t("observability.tracesNote")}</p>
          {spans.length === 0 ? (
            <div style={emptyStyle}>{t("observability.tracesEmpty")}</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th>{t("observability.colSpan")}</th>
                  <th>{t("observability.colTraceId")}</th>
                  <th style={{ textAlign: "right" }}>{t("observability.colDurationMs")}</th>
                  <th>{t("observability.colStatus")}</th>
                  <th>{t("observability.colAttributes")}</th>
                </tr>
              </thead>
              <tbody>
                {spans.slice(0, 50).map((s) => {
                  const statusLabel = s.statusCode === 2 ? "ERROR" : s.statusCode === 1 ? "OK" : "—";
                  const statusColor = s.statusCode === 2 ? tg.destructive : tg.hint;
                  return (
                    <tr key={`${s.traceId}-${s.name}`}>
                      <td style={{ ...monoCell, fontSize: 12 }}>{s.name}</td>
                      <td style={{ ...monoCell, fontSize: 11 }}>{s.traceId.slice(0, 16)}…</td>
                      <td style={numCell}>{s.durationMs}</td>
                      <td style={{ color: statusColor, fontSize: 12 }}>{statusLabel}</td>
                      <td style={{ ...monoCell, color: tg.hint, fontSize: 11, wordBreak: "break-all" }}>
                        {fmtAttrs(s.attrs)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section style={{ marginTop: 32 }}>
          <h2 style={sectionH2}>{t("observability.metricsHeading")}</h2>
          <p style={{ ...noteStyle, margin: "0 0 12px 0" }}>{t("observability.metricsNote")}</p>

          {metrics.gauges.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, margin: "0 0 6px 0", color: "#666" }}>{t("observability.gaugesHeading")}</h3>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th>{t("observability.colMetric")}</th>
                    <th>{t("observability.colLabels")}</th>
                    <th style={{ textAlign: "right" }}>{t("observability.colValue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.gauges.flatMap((g) =>
                    g.points.map((p) => (
                      <tr key={`${g.name}-${fmtLabels(p.labels)}`}>
                        <td>
                          <code style={{ fontSize: 12 }}>{g.name}</code>
                        </td>
                        <td>{fmtLabels(p.labels)}</td>
                        <td style={numCell}>{p.value}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {hasCounters && (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, margin: "0 0 6px 0", color: "#666" }}>{t("observability.countersHeading")}</h3>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th>{t("observability.colMetric")}</th>
                    <th>{t("observability.colLabels")}</th>
                    <th style={{ textAlign: "right" }}>{t("observability.colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.counters.flatMap((cnt) =>
                    cnt.points.map((p) => (
                      <tr key={`${cnt.name}-${fmtLabels(p.labels)}`}>
                        <td>
                          <code style={{ fontSize: 12 }}>{cnt.name}</code>
                        </td>
                        <td>{fmtLabels(p.labels)}</td>
                        <td style={numCell}>{p.value}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {hasHistograms && (
            <div>
              <h3 style={{ fontSize: 13, margin: "0 0 6px 0", color: "#666" }}>
                {t("observability.histogramsHeading")}
              </h3>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th>{t("observability.colMetric")}</th>
                    <th>{t("observability.colLabels")}</th>
                    <th style={{ textAlign: "right" }}>{t("observability.colCount")}</th>
                    <th style={{ textAlign: "right" }}>p50 (ms)</th>
                    <th style={{ textAlign: "right" }}>p95 (ms)</th>
                    <th style={{ textAlign: "right" }}>p99 (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.histograms.flatMap((h) =>
                    h.points.map((p) => (
                      <tr key={`${h.name}-${fmtLabels(p.labels)}`}>
                        <td>
                          <code style={{ fontSize: 12 }}>{h.name}</code>
                        </td>
                        <td>{fmtLabels(p.labels)}</td>
                        <td style={numCell}>{p.count}</td>
                        <td style={numCell}>{quantileMs(h.boundaries, p.buckets, p.count, 0.5)}</td>
                        <td style={numCell}>{quantileMs(h.boundaries, p.buckets, p.count, 0.95)}</td>
                        <td style={numCell}>{quantileMs(h.boundaries, p.buckets, p.count, 0.99)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p style={{ color: tg.hint, fontSize: 12, marginTop: 24 }}>{t("observability.dataSources")}</p>
      </main>
    </Layout>
  );
}

/** Server entry: the Bun backend imports this and calls it per request. */
export function render(props: ObservabilityProps): string {
  return `<!DOCTYPE html>${renderToString(<ObservabilityPage {...props} />)}`;
}
