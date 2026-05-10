import type { Metadata } from "next";
import { config } from "@/lib/config";
import s from "../legal.module.css";

const TITLE = `Terms of Service — ${config.brandName}`;
const DESCRIPTION = `Terms of service for ${config.brandName} hosted Telegram MCP connector.`;
const URL = `${config.issuer}/terms`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { url: URL, title: TITLE, description: DESCRIPTION },
  twitter: { title: TITLE, description: DESCRIPTION },
};

export default function TermsPage() {
  const hostLabel = config.issuer.replace(/^https?:\/\//, "");
  const repoLabel = config.sourceRepoUrl.replace(/^https?:\/\//, "");

  return (
    <div className={s.container}>
      <a href="/" className={s.logo}>
        {/* biome-ignore lint/performance/noImgElement: served from Hono backend, not next/image-optimised. */}
        <img src="/icon.svg" alt="Telegram" width={24} height={24} />
        {config.brandName}
      </a>

      <h1 className={s.h1}>Terms of Service</h1>
      <p className={s.updated}>Last updated: April 27, 2026</p>

      <h2 className={s.h2}>1. Service description</h2>
      <p className={s.p}>
        {config.brandName} (
        <a className={s.link} href={config.issuer}>
          {hostLabel}
        </a>
        ) is a hosted connector that lets AI assistants (Claude, ChatGPT) access your Telegram account via the MCP
        protocol. The service operates in read-only mode — it cannot send, edit, or delete messages on your behalf.
      </p>

      <h2 className={s.h2}>2. Acceptance</h2>
      <p className={s.p}>
        By connecting your Telegram account to {config.brandName}, you agree to these terms. If you do not agree,
        disconnect the service immediately.
      </p>

      <h2 className={s.h2}>3. Your account</h2>
      <ul className={s.ul}>
        <li>You must have a valid Telegram account to use the service.</li>
        <li>You are responsible for maintaining the security of your Telegram account.</li>
        <li>You may disconnect at any time from Telegram Settings → Devices.</li>
      </ul>

      <h2 className={s.h2}>4. Permitted use</h2>
      <p className={s.p}>
        You may use {config.brandName} for personal, lawful purposes — reading your own messages, searching your chats,
        and accessing your contacts through AI assistants. You may not use the service to violate Telegram's Terms of
        Service, harass others, or access accounts you do not own.
      </p>

      <h2 className={s.h2}>5. Data and privacy</h2>
      <p className={s.p}>
        Your data is handled as described in our{" "}
        <a className={s.link} href="/privacy">
          Privacy Policy
        </a>
        . Message content passes through our server but is not stored or logged. Session tokens are encrypted and
        deleted when you disconnect.
      </p>

      <h2 className={s.h2}>6. Service availability</h2>
      <p className={s.p}>
        {config.brandName} is provided "as is" without warranty. The hosted instance is best-effort, maintained by a
        solo developer in spare time — there is no SLA and no guarantee of uninterrupted service. We may modify,
        suspend, or discontinue the hosted service at any time with reasonable notice. If you need stronger guarantees,
        self-host the open source code.
      </p>

      <h2 className={s.h2}>7. Limitation of liability</h2>
      <p className={s.p}>
        To the maximum extent permitted by law, {config.brandName} and its operator shall not be liable for any
        indirect, incidental, or consequential damages arising from your use of the service.
      </p>

      <h2 className={s.h2}>8. Open source</h2>
      <p className={s.p}>
        The server is open source under the MIT license at{" "}
        <a className={s.link} href={config.sourceRepoUrl}>
          {repoLabel}
        </a>
        . You may self-host the server for full control over your data.
      </p>

      <h2 className={s.h2}>9. Changes</h2>
      <p className={s.p}>
        We may update these terms from time to time. Continued use of the service after changes constitutes acceptance.
        Material changes will be communicated via the website.
      </p>

      <h2 className={s.h2}>10. Contact</h2>
      <p className={s.p}>
        Questions about these terms? Reach out via{" "}
        <a className={s.link} href={config.issuesUrl}>
          {config.issuesLabel}
        </a>
        {config.contactTelegram && (
          <>
            {" "}
            or Telegram{" "}
            <a className={s.link} href={`https://t.me/${config.contactTelegram}`}>
              @{config.contactTelegram}
            </a>
          </>
        )}
        {config.contactEmail && (
          <>
            {" "}
            or email{" "}
            <a className={s.link} href={`mailto:${config.contactEmail}`}>
              {config.contactEmail}
            </a>
          </>
        )}
        .
      </p>
    </div>
  );
}
