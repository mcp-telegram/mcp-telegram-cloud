import { css, cx } from "hono/css";
import type { FC } from "hono/jsx";
import type { TelemetryMode } from "../config.js";
import { card, subtitle, tg, title } from "../styles.js";
import type { ErrorEntry } from "../telemetry/error-buffer.js";
import type { snapshot } from "../telemetry/metrics.js";
import type { FinishedSpan } from "../telemetry/tracer.js";
import { Layout } from "./Layout.js";

type MetricsSnapshot = ReturnType<typeof snapshot>;

interface ObservabilityPageProps {
  telemetryMode: TelemetryMode;
  signozEndpointConfigured: boolean;
  daily: { date: string; count: number }[];
  dau: { date: string; activeUsers: number }[];
  clients: { client: string; totalCalls: number; uniqueUsers: number }[];
  topUsers: { userId: string; totalCalls: number }[];
  recentErrors: ErrorEntry[];
  metrics: MetricsSnapshot;
  spans: FinishedSpan[];
}

const wide = css`
  max-width: 1024px;
  text-align: left;
`;

const grid2 = css`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`;

const tbl = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  th, td {
    padding: 6px 10px;
    border-bottom: 1px solid ${tg.tertiaryBg};
    vertical-align: top;
  }
  th {
    text-align: left;
    color: ${tg.hint};
    font-weight: 500;
    background: ${tg.tertiaryBg};
  }
  td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
`;

const empty = css`
  color: ${tg.hint};
  font-size: 13px;
  padding: 12px 0;
  text-align: center;
`;

const badge = css`
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
`;

const errMsg = css`
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-word;
`;

const errAttrs = css`
  color: ${tg.hint};
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
  margin-top: 2px;
`;

const modeColors: Record<ObservabilityPageProps["telemetryMode"], { bg: string; fg: string }> = {
  on: { bg: "#2ea043", fg: "#fff" },
  "local-only": { bg: "#0969da", fg: "#fff" },
  off: { bg: "#6e7781", fg: "#fff" },
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
    cumulative += buckets[i];
    if (cumulative >= target) return `${boundaries[i]}`;
  }
  return `>${boundaries[boundaries.length - 1]}`;
}

export const ObservabilityPage: FC<ObservabilityPageProps> = ({
  telemetryMode,
  signozEndpointConfigured,
  daily,
  dau,
  clients,
  topUsers,
  recentErrors,
  metrics,
  spans,
}) => {
  const c = modeColors[telemetryMode];
  const badgeStyle = `background:${c.bg};color:${c.fg};`;
  const warnStyle = `color:${tg.destructive};margin-left:8px;font-size:12px;`;
  const hintStyle = `color:${tg.hint};font-size:12px;margin-top:24px;`;
  return (
    <Layout title="Observability — Admin" description="Local observability dashboard">
      <main class={cx(card, wide)}>
        <h1 class={title}>Observability</h1>
        <p class={subtitle}>
          Telemetry mode:{" "}
          <span class={badge} style={badgeStyle}>
            {telemetryMode}
          </span>
          {telemetryMode === "on" && !signozEndpointConfigured && (
            <span style={warnStyle}>⚠ SIGNOZ_ENDPOINT not set — outbound disabled</span>
          )}
        </p>

        <section style="margin-top:24px;">
          <h2 style="font-size:16px;margin:0 0 8px 0;">Tool calls (daily)</h2>
          {daily.length === 0 ? (
            <div class={empty}>No usage recorded yet.</div>
          ) : (
            <table class={tbl}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th style="text-align:right;">Calls</th>
                  <th style="text-align:right;">Active users</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => {
                  const dauRow = dau.find((x) => x.date === d.date);
                  return (
                    <tr>
                      <td>{d.date}</td>
                      <td class="num">{d.count}</td>
                      <td class="num">{dauRow?.activeUsers ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section class={grid2} style="margin-top:24px;">
          <div>
            <h2 style="font-size:16px;margin:0 0 8px 0;">By client</h2>
            {clients.length === 0 ? (
              <div class={empty}>No client data.</div>
            ) : (
              <table class={tbl}>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th style="text-align:right;">Calls</th>
                    <th style="text-align:right;">Users</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((cl) => (
                    <tr>
                      <td>{cl.client}</td>
                      <td class="num">{cl.totalCalls}</td>
                      <td class="num">{cl.uniqueUsers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h2 style="font-size:16px;margin:0 0 8px 0;">Top users</h2>
            {topUsers.length === 0 ? (
              <div class={empty}>No users yet.</div>
            ) : (
              <table class={tbl}>
                <thead>
                  <tr>
                    <th>User ID</th>
                    <th style="text-align:right;">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {topUsers.map((u) => (
                    <tr>
                      <td>{u.userId}</td>
                      <td class="num">{u.totalCalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section style="margin-top:24px;">
          <h2 style="font-size:16px;margin:0 0 8px 0;">Recent errors ({recentErrors.length})</h2>
          {recentErrors.length === 0 ? (
            <div class={empty}>No errors recorded since process start.</div>
          ) : (
            <table class={tbl}>
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Message + attrs</th>
                </tr>
              </thead>
              <tbody>
                {recentErrors.map((e) => (
                  <tr>
                    <td style="white-space:nowrap;font-size:11px;">{e.timestamp.replace("T", " ").slice(0, 19)}</td>
                    <td>
                      <div class={errMsg}>{e.message}</div>
                      {Object.keys(e.attrs).length > 0 && <div class={errAttrs}>{fmtAttrs(e.attrs)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section style="margin-top:24px;">
          <h2 style="font-size:16px;margin:0 0 8px 0;">Recent traces ({spans.length})</h2>
          <p style="color:#888;font-size:12px;margin:0 0 8px 0;">
            Last {spans.length} finished spans (in-memory, lost on restart). Newest at top. Same spans exported to
            SigNoz when <code style="font-size:11px;">MCP_TELEGRAM_TELEMETRY=on</code>; sampling 100%.
          </p>
          {spans.length === 0 ? (
            <div class={empty}>No spans recorded yet.</div>
          ) : (
            <table class={tbl}>
              <thead>
                <tr>
                  <th>Span</th>
                  <th>Trace ID</th>
                  <th style="text-align:right;">Duration (ms)</th>
                  <th>Status</th>
                  <th>Attributes</th>
                </tr>
              </thead>
              <tbody>
                {spans
                  .slice()
                  .reverse()
                  .slice(0, 50)
                  .map((s) => {
                    const durationMs = Number((s.endTimeNs - s.startTimeNs) / 1_000_000n);
                    const flatAttrs = Object.fromEntries(Object.entries(s.attributes).map(([k, v]) => [k, String(v)]));
                    const statusLabel = s.status.code === 2 ? "ERROR" : s.status.code === 1 ? "OK" : "—";
                    const statusColor = s.status.code === 2 ? tg.destructive : tg.hint;
                    return (
                      <tr>
                        <td style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;">
                          {s.name}
                        </td>
                        <td style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;">
                          {s.context.traceId.slice(0, 16)}…
                        </td>
                        <td class="num">{durationMs}</td>
                        <td style={`color:${statusColor};font-size:12px;`}>{statusLabel}</td>
                        <td class={errAttrs}>{fmtAttrs(flatAttrs)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </section>

        <section style="margin-top:32px;">
          <h2 style="font-size:16px;margin:0 0 8px 0;">Process metrics</h2>
          <p style="color:#888;font-size:12px;margin:0 0 12px 0;">
            Cumulative since process start. Same numbers exported to SigNoz when{" "}
            <code style="font-size:11px;">MCP_TELEGRAM_TELEMETRY=on</code>.
          </p>
          {metrics.gauges.length > 0 && (
            <div style="margin-bottom:16px;">
              <h3 style="font-size:13px;margin:0 0 6px 0;color:#666;">Gauges</h3>
              <table class={tbl}>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Labels</th>
                    <th style="text-align:right;">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.gauges.flatMap((g) =>
                    g.points.map((p) => (
                      <tr>
                        <td>
                          <code style="font-size:12px;">{g.name}</code>
                        </td>
                        <td>{fmtLabels(p.labels)}</td>
                        <td class="num">{p.value}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {metrics.counters.some((c) => c.points.length > 0) && (
            <div style="margin-bottom:16px;">
              <h3 style="font-size:13px;margin:0 0 6px 0;color:#666;">Counters</h3>
              <table class={tbl}>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Labels</th>
                    <th style="text-align:right;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.counters.flatMap((cnt) =>
                    cnt.points.map((p) => (
                      <tr>
                        <td>
                          <code style="font-size:12px;">{cnt.name}</code>
                        </td>
                        <td>{fmtLabels(p.labels)}</td>
                        <td class="num">{p.value}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {metrics.histograms.some((h) => h.points.length > 0) && (
            <div>
              <h3 style="font-size:13px;margin:0 0 6px 0;color:#666;">Latency histograms</h3>
              <table class={tbl}>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Labels</th>
                    <th style="text-align:right;">Count</th>
                    <th style="text-align:right;">p50 (ms)</th>
                    <th style="text-align:right;">p95 (ms)</th>
                    <th style="text-align:right;">p99 (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.histograms.flatMap((h) =>
                    h.points.map((p) => (
                      <tr>
                        <td>
                          <code style="font-size:12px;">{h.name}</code>
                        </td>
                        <td>{fmtLabels(p.labels)}</td>
                        <td class="num">{p.count}</td>
                        <td class="num">{quantileMs(h.boundaries, p.buckets, p.count, 0.5)}</td>
                        <td class="num">{quantileMs(h.boundaries, p.buckets, p.count, 0.95)}</td>
                        <td class="num">{quantileMs(h.boundaries, p.buckets, p.count, 0.99)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p style={hintStyle}>
          Data sources: SQLite usage_log (daily/clients/users), in-memory ring buffer (errors, lost on restart),
          in-process counters/histograms/gauges (metrics, lost on restart). See SECURITY.md for the full privacy
          contract.
        </p>
      </main>
    </Layout>
  );
};
