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

export const TermsPage: FC = () => {
  return (
    <Layout
      title="Terms of Service — MCP Telegram"
      description="Terms of service for mcp-telegram.com hosted Telegram MCP connector."
      canonicalUrl="https://mcp-telegram.com/terms"
      globalCss={landingReset}
    >
      <div class={s.container}>
        <a href="/" class={s.logo}>
          <img src="/icon.svg" alt="Telegram" width="24" height="24" />
          MCP Telegram
        </a>

        <h1 class={s.h1}>Terms of Service</h1>
        <p class={s.updated}>Last updated: March 19, 2026</p>

        <h2 class={s.h2}>1. Service description</h2>
        <p class={s.p}>
          MCP Telegram (
          <a class={s.link} href="https://mcp-telegram.com">
            mcp-telegram.com
          </a>
          ) is a hosted connector that lets AI assistants (Claude, ChatGPT) access your Telegram account via the MCP
          protocol. The service operates in read-only mode — it cannot send, edit, or delete messages on your behalf.
        </p>

        <h2 class={s.h2}>2. Acceptance</h2>
        <p class={s.p}>
          By connecting your Telegram account to MCP Telegram, you agree to these terms. If you do not agree, disconnect
          the service immediately.
        </p>

        <h2 class={s.h2}>3. Your account</h2>
        <ul class={s.ul}>
          <li>You must have a valid Telegram account to use the service.</li>
          <li>You are responsible for maintaining the security of your Telegram account.</li>
          <li>You may disconnect at any time from Telegram Settings → Devices.</li>
        </ul>

        <h2 class={s.h2}>4. Permitted use</h2>
        <p class={s.p}>
          You may use MCP Telegram for personal, lawful purposes — reading your own messages, searching your chats, and
          accessing your contacts through AI assistants. You may not use the service to violate Telegram's Terms of
          Service, harass others, or access accounts you do not own.
        </p>

        <h2 class={s.h2}>5. Data and privacy</h2>
        <p class={s.p}>
          Your data is handled as described in our{" "}
          <a class={s.link} href="/privacy">
            Privacy Policy
          </a>
          . Message content passes through our server but is not stored or logged. Session tokens are encrypted and
          deleted when you disconnect.
        </p>

        <h2 class={s.h2}>6. Service availability</h2>
        <p class={s.p}>
          MCP Telegram is provided "as is" without warranty. We aim for high availability but do not guarantee
          uninterrupted service. We may modify, suspend, or discontinue the service at any time with reasonable notice.
        </p>

        <h2 class={s.h2}>7. Limitation of liability</h2>
        <p class={s.p}>
          To the maximum extent permitted by law, MCP Telegram and its operator shall not be liable for any indirect,
          incidental, or consequential damages arising from your use of the service.
        </p>

        <h2 class={s.h2}>8. Open source</h2>
        <p class={s.p}>
          The core MCP server is open source under the MIT license at{" "}
          <a class={s.link} href="https://github.com/mcp-telegram/mcp-telegram">
            github.com/mcp-telegram/mcp-telegram
          </a>
          . You may self-host the server for full control over your data.
        </p>

        <h2 class={s.h2}>9. Changes</h2>
        <p class={s.p}>
          We may update these terms from time to time. Continued use of the service after changes constitutes
          acceptance. Material changes will be communicated via the website.
        </p>

        <h2 class={s.h2}>10. Contact</h2>
        <p class={s.p}>
          Questions about these terms? Reach out via{" "}
          <a class={s.link} href="https://github.com/mcp-telegram/mcp-telegram/issues">
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
