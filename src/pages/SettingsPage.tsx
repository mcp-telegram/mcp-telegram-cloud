import { css, cx } from "hono/css";
import type { FC } from "hono/jsx";
import { config } from "../config.js";
import { card, subtitle, tg, title } from "../styles.js";
import { Layout } from "./Layout.js";

interface SettingsPageProps {
  username: string;
  enabled: boolean;
  todayCount: number;
  dailyLimit: number;
  /** Optional flash message rendered above the form, e.g. "Saved." after a POST round-trip. */
  flash?: string;
}

const settingsCard = css`
  max-width: 560px;
  text-align: left;
`;

const sectionLabel = css`
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${tg.hint};
  margin-top: 24px;
  margin-bottom: 8px;
`;

const row = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid ${tg.outline};
  &:last-of-type { border-bottom: none; }
`;

const rowLabel = css`
  font-size: 15px;
  color: ${tg.text};
`;

const rowValue = css`
  font-size: 14px;
  color: ${tg.hint};
  font-variant-numeric: tabular-nums;
`;

const helpText = css`
  font-size: 13px;
  color: ${tg.hint};
  line-height: 1.5;
  margin-top: 16px;
  background: ${tg.tertiaryBg};
  padding: 12px 16px;
  border-radius: 12px;
`;

const submit = css`
  background: ${tg.button};
  color: ${tg.buttonText};
  border: none;
  border-radius: 12px;
  padding: 12px 24px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 16px;
  &:hover { opacity: 0.9; }
`;

const submitDestructive = css`
  background: ${tg.destructive};
`;

const flashOk = css`
  background: ${tg.tertiaryBg};
  border-left: 3px solid ${tg.green};
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
  color: ${tg.text};
`;

const navLink = css`
  display: inline-block;
  margin-top: 24px;
  color: ${tg.link};
  text-decoration: none;
  font-size: 14px;
  &:hover { text-decoration: underline; }
`;

const inlineLink = css`
  color: ${tg.link};
  text-decoration: none;
  &:hover { text-decoration: underline; }
`;

export const SettingsPage: FC<SettingsPageProps> = ({ username, enabled, todayCount, dailyLimit, flash }) => {
  const limitDisplay = dailyLimit > 0 ? `${todayCount} / ${dailyLimit}` : `${todayCount} / unlimited`;
  return (
    <Layout
      title={`${config.brandName} — Settings`}
      description="Manage destructive-tool access for your Telegram MCP account."
    >
      <div class={cx(card, settingsCard)}>
        <h1 class={title}>Settings</h1>
        <p class={subtitle}>
          Signed in as <strong>@{username}</strong>
        </p>

        {flash && <div class={flashOk}>{flash}</div>}

        <div class={sectionLabel}>Destructive tools</div>
        <div class={row}>
          <span class={rowLabel}>Status</span>
          <span class={rowValue}>{enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <div class={row}>
          <span class={rowLabel}>Today's destructive calls</span>
          <span class={rowValue}>{limitDisplay}</span>
        </div>

        <div class={helpText}>
          <strong>What this controls:</strong> 11 tools that perform irreversible actions — delete messages, delete
          stories, revoke invite links, change chat-wide permissions, edit story content, and similar. Server-default
          OFF; turn ON only when an LLM client should be allowed to do these. Each call is recorded in your{" "}
          <a href="/my/audit" class={inlineLink}>
            audit log
          </a>
          .
        </div>

        <form method="post" action="/my/settings">
          <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
          <button type="submit" class={enabled ? cx(submit, submitDestructive) : submit}>
            {enabled ? "Disable destructive tools" : "Enable destructive tools"}
          </button>
        </form>

        <a class={navLink} href="/my/audit">
          View audit log →
        </a>
      </div>
    </Layout>
  );
};
