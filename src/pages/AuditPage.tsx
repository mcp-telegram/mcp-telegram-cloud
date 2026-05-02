import { css, cx } from "hono/css";
import type { FC } from "hono/jsx";
import { config } from "../config.js";
import type { AuditRow } from "../destructive-guard.js";
import { card, subtitle, tg, title } from "../styles.js";
import { Layout } from "./Layout.js";

interface AuditPageProps {
  username: string;
  rows: AuditRow[];
}

const wide = css`
  max-width: 880px;
  text-align: left;
`;

const empty = css`
  background: ${tg.tertiaryBg};
  padding: 24px;
  border-radius: 12px;
  color: ${tg.hint};
  text-align: center;
  font-size: 14px;
`;

const tbl = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  margin-top: 16px;
  & th {
    text-align: left;
    padding: 10px 12px;
    background: ${tg.tertiaryBg};
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${tg.hint};
  }
  & td {
    padding: 10px 12px;
    border-bottom: 1px solid ${tg.outline};
    vertical-align: top;
  }
  & tr:last-child td {
    border-bottom: none;
  }
`;

const dateCell = css`
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: ${tg.hint};
`;

const argsCell = css`
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
  color: ${tg.hint};
  word-break: break-word;
`;

const navLink = css`
  display: inline-block;
  margin-top: 24px;
  color: ${tg.link};
  text-decoration: none;
  font-size: 14px;
  &:hover { text-decoration: underline; }
`;

const badgeOk = css`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(49, 209, 88, .15);
  color: #1d8a3a;
`;
const badgeDenied = css`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(229, 57, 53, .12);
  color: ${tg.destructive};
`;
const badgeError = css`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(0, 122, 255, .12);
  color: ${tg.link};
`;

function badgeFor(result: string) {
  if (result === "ok") return badgeOk;
  if (result.startsWith("denied")) return badgeDenied;
  return badgeError;
}

function labelFor(result: string): string {
  if (result === "ok") return "ok";
  if (result === "denied_disabled") return "denied (disabled)";
  if (result === "denied_quota") return "denied (quota)";
  return result;
}

export const AuditPage: FC<AuditPageProps> = ({ username, rows }) => {
  return (
    <Layout
      title={`${config.brandName} — Audit log`}
      description="History of destructive-tool calls for your Telegram MCP account."
    >
      <div class={cx(card, wide)}>
        <h1 class={title}>Audit log</h1>
        <p class={subtitle}>
          Last {rows.length} destructive call{rows.length === 1 ? "" : "s"} for <strong>@{username}</strong>
        </p>

        {rows.length === 0 ? (
          <div class={empty}>
            No destructive calls recorded yet. When an LLM client invokes a destructive tool through your account, it
            shows up here — including denied attempts.
          </div>
        ) : (
          <table class={tbl}>
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Result</th>
                <th>Args</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class={dateCell}>{r.created_at}</td>
                  <td>{r.tool_name}</td>
                  <td>
                    <span class={badgeFor(r.result)}>{labelFor(r.result)}</span>
                  </td>
                  <td class={argsCell}>{r.args_summary || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <a class={navLink} href="/my/settings">
          ← Back to settings
        </a>
      </div>
    </Layout>
  );
};
