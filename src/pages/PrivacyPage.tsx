import { css } from "hono/css";
import type { FC } from "hono/jsx";
import { landingReset, tg } from "../styles.js";
import { Layout } from "./Layout.js";

const s = {
  container: css`
    max-width: 720px;
    margin: 0 auto;
    padding: 40px 20px 80px;
    font-family: ${tg.font};
    color: ${tg.text};
    line-height: 1.7;
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 40px;
  `,
  logo: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 18px;
    font-weight: 600;
    color: ${tg.text};
    text-decoration: none;
  `,
  h1: css`
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 8px;
  `,
  updated: css`
    color: ${tg.hint};
    font-size: 14px;
    margin: 0 0 32px;
  `,
  h2: css`
    font-size: 20px;
    font-weight: 600;
    margin: 32px 0 12px;
  `,
  p: css`
    margin: 0 0 16px;
    color: ${tg.text};
  `,
  ul: css`
    margin: 0 0 16px;
    padding-left: 24px;
  `,
  link: css`
    color: ${tg.link};
    text-decoration: none;
    &:hover { text-decoration: underline; }
  `,
};

export const PrivacyPage: FC = () => {
  return (
    <Layout
      title="Privacy Policy — MCP Telegram"
      description="Privacy policy for mcp-telegram.com hosted Telegram MCP connector."
      globalCss={landingReset}
    >
      <div class={s.container}>
        <a href="/" class={s.logo}>
          <img src="/icon.svg" alt="Telegram" width="24" height="24" />
          MCP Telegram
        </a>

        <h1 class={s.h1}>Privacy Policy</h1>
        <p class={s.updated}>Last updated: March 19, 2026</p>

        <h2 class={s.h2}>Overview</h2>
        <p class={s.p}>
          MCP Telegram (
          <a class={s.link} href="https://mcp-telegram.com">
            mcp-telegram.com
          </a>
          ) is a hosted connector that lets AI assistants (Claude, ChatGPT) access your Telegram account via the MCP
          protocol. Your privacy is important to us. This policy explains what data we collect, how we use it, and your
          rights.
        </p>

        <h2 class={s.h2}>What we collect</h2>
        <ul class={s.ul}>
          <li>
            <strong>Telegram session data</strong> — An encrypted session token is stored on our server so you stay
            connected between requests. It is deleted when you disconnect.
          </li>
          <li>
            <strong>Usage logs</strong> — We log which MCP tools are called (e.g. "list-chats", "read-messages"), the
            timestamp, and your Telegram user ID. We do <em>not</em> log message content, chat names, or any personal
            data from your chats.
          </li>
          <li>
            <strong>OAuth tokens</strong> — Temporary tokens for authenticating your AI client (Claude/ChatGPT) to our
            server. Stored in memory, not persisted.
          </li>
        </ul>

        <h2 class={s.h2}>What we do NOT collect</h2>
        <ul class={s.ul}>
          <li>Message content, media files, or chat history</li>
          <li>Phone numbers, contact lists, or profile data</li>
          <li>Passwords or Telegram 2FA codes</li>
          <li>Analytics cookies or tracking pixels</li>
        </ul>

        <h2 class={s.h2}>How your data flows</h2>
        <p class={s.p}>
          When you ask Claude or ChatGPT to read your Telegram messages, the AI client sends a request to our server.
          Our server fetches data from Telegram's API using your session, returns it to the AI client, and does not
          retain it. Message content passes through our server but is <strong>not stored or logged</strong>.
        </p>

        <h2 class={s.h2}>Data retention</h2>
        <ul class={s.ul}>
          <li>
            <strong>Session tokens</strong> — Deleted when you disconnect or after inactivity.
          </li>
          <li>
            <strong>Usage logs</strong> — Retained for analytics and rate limiting. No personal content.
          </li>
          <li>
            <strong>OAuth data</strong> — In-memory only, cleared on server restart.
          </li>
        </ul>

        <h2 class={s.h2}>Third parties</h2>
        <p class={s.p}>
          We do not sell, share, or transfer your data to third parties. Your Telegram data is only accessed via the
          official Telegram MTProto API on your behalf. The AI client (Anthropic/OpenAI) receives your Telegram data as
          part of the conversation — their privacy policies apply to that processing.
        </p>

        <h2 class={s.h2}>Security</h2>
        <p class={s.p}>
          All connections use TLS (HTTPS). Telegram sessions are encrypted. The server runs on dedicated infrastructure
          with access restricted to the operator. We follow security best practices for session management and
          credential storage.
        </p>

        <h2 class={s.h2}>Your rights</h2>
        <ul class={s.ul}>
          <li>
            <strong>Disconnect anytime</strong> — Remove the connector in Claude/ChatGPT settings. Your session is
            deleted immediately.
          </li>
          <li>
            <strong>Data deletion</strong> — Contact us to request full deletion of any stored data.
          </li>
          <li>
            <strong>Self-host option</strong> — Use the{" "}
            <a class={s.link} href="https://github.com/overpod/mcp-telegram">
              open-source version
            </a>{" "}
            to run everything on your own machine with zero data leaving your device.
          </li>
        </ul>

        <h2 class={s.h2}>Open source</h2>
        <p class={s.p}>
          The core MCP server is open source under the MIT license at{" "}
          <a class={s.link} href="https://github.com/overpod/mcp-telegram">
            github.com/overpod/mcp-telegram
          </a>
          . You can inspect exactly what data is accessed and how.
        </p>

        <h2 class={s.h2}>Contact</h2>
        <p class={s.p}>
          Questions about this policy? Reach out via{" "}
          <a class={s.link} href="https://github.com/overpod/mcp-telegram/issues">
            GitHub Issues
          </a>{" "}
          or Telegram{" "}
          <a class={s.link} href="https://t.me/overpod">
            @overpod
          </a>
          .
        </p>
      </div>
    </Layout>
  );
};
