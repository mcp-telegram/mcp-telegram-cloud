import { css, cx } from "hono/css";
import type { FC } from "hono/jsx";
import type { TelemetryMode } from "../config.js";
import { card, subtitle, tg, title } from "../styles.js";
import type { ErrorEntry } from "../telemetry/error-buffer.js";
import { Layout } from "./Layout.js";

interface ObservabilityPageProps {
  telemetryMode: TelemetryMode;
  signozEndpointConfigured: boolean;
  daily: { date: string; count: number }[];
  dau: { date: string; activeUsers: number }[];
  clients: { client: string; totalCalls: number; uniqueUsers: number }[];
  topUsers: { userId: string; totalCalls: number }[];
  recentErrors: ErrorEntry[];
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

export const ObservabilityPage: FC<ObservabilityPageProps> = ({
  telemetryMode,
  signozEndpointConfigured,
  daily,
  dau,
  clients,
  topUsers,
  recentErrors,
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

        <p style={hintStyle}>
          Data sources: SQLite usage_log (daily/clients/users), in-memory ring buffer (errors, lost on restart). See
          SECURITY.md for the full privacy contract.
        </p>
      </main>
    </Layout>
  );
};
