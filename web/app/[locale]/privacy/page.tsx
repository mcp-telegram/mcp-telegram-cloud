import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../../legal.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const TITLE = `Privacy Policy — ${config.brandName}`;
const DESCRIPTION = `Privacy policy for ${config.brandName} hosted Telegram MCP connector.`;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const canonical = canonicalForLocale(locale, "/privacy");
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical, languages: languageAlternates("/privacy") },
    openGraph: { url: canonical, title: TITLE, description: DESCRIPTION },
    twitter: { title: TITLE, description: DESCRIPTION },
  };
}

export default async function PrivacyPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const hostLabel = config.issuer.replace(/^https?:\/\//, "");
  const repoLabel = config.sourceRepoUrl.replace(/^https?:\/\//, "");

  return (
    <div className={s.container}>
      <a href="/" className={s.logo}>
        {/* biome-ignore lint/performance/noImgElement: served from Hono backend, not next/image-optimised. */}
        <img src="/icon.svg" alt="Telegram" width={24} height={24} />
        {config.brandName}
      </a>

      <h1 className={s.h1}>Privacy Policy</h1>
      <p className={s.updated}>Last updated: April 27, 2026</p>

      <h2 className={s.h2}>Overview</h2>
      <p className={s.p}>
        {config.brandName} (
        <a className={s.link} href={config.issuer}>
          {hostLabel}
        </a>
        ) is a hosted connector that lets AI assistants (Claude, ChatGPT) access your Telegram account via the MCP
        protocol. Your privacy is important to us. This policy explains what data we collect, how we use it, and your
        rights.
      </p>

      <h2 className={s.h2}>What we collect</h2>
      <ul className={s.ul}>
        <li>
          <strong>Telegram session data</strong> — An encrypted session token is stored on our server so you stay
          connected between requests. It is deleted when you disconnect.
        </li>
        <li>
          <strong>Usage logs</strong> — We log which MCP tools are called (e.g. "list-chats", "read-messages"), the
          timestamp, and your Telegram user ID. We do <em>not</em> log message content, chat names, or any personal data
          from your chats.
        </li>
        <li>
          <strong>OAuth tokens</strong> — Temporary tokens for authenticating your AI client (Claude/ChatGPT) to our
          server. Stored in memory, not persisted.
        </li>
      </ul>

      <h2 className={s.h2}>What we do NOT collect</h2>
      <ul className={s.ul}>
        <li>Message content, media files, or chat history</li>
        <li>Phone numbers, contact lists, or profile data</li>
        <li>Passwords or Telegram 2FA codes</li>
        <li>Analytics cookies or tracking pixels</li>
      </ul>

      <h2 className={s.h2}>How your data flows</h2>
      <p className={s.p}>
        When you ask Claude or ChatGPT to read your Telegram messages, the AI client sends a request to our server. Our
        server fetches data from Telegram's API using your session, returns it to the AI client, and does not retain it.
        Message content passes through our server but is <strong>not stored or logged</strong>.
      </p>

      <h2 className={s.h2}>Data retention</h2>
      <ul className={s.ul}>
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

      <h2 className={s.h2}>Third parties</h2>
      <p className={s.p}>
        We do not sell, share, or transfer your data to third parties. Your Telegram data is only accessed via the
        official Telegram MTProto API on your behalf. The AI client (Anthropic/OpenAI) receives your Telegram data as
        part of the conversation — their privacy policies apply to that processing.
      </p>

      <h2 className={s.h2}>Security</h2>
      <p className={s.p}>
        All connections use TLS (HTTPS). Telegram sessions are encrypted. The server runs on dedicated infrastructure
        with access restricted to the operator. We follow security best practices for session management and credential
        storage.
      </p>

      <h2 className={s.h2}>Your rights</h2>
      <ul className={s.ul}>
        <li>
          <strong>Disconnect anytime</strong> — Remove the connector in Claude/ChatGPT settings. Your session is deleted
          immediately.
        </li>
        <li>
          <strong>Data deletion</strong> — Contact us to request full deletion of any stored data.
        </li>
        <li>
          <strong>Self-host option</strong> — Use the{" "}
          <a className={s.link} href={config.sourceRepoUrl}>
            open-source version
          </a>{" "}
          to run everything on your own machine with zero data leaving your device.
        </li>
      </ul>

      <h2 className={s.h2}>Open source</h2>
      <p className={s.p}>
        The server is open source under the MIT license at{" "}
        <a className={s.link} href={config.sourceRepoUrl}>
          {repoLabel}
        </a>
        . You can inspect exactly what data is accessed and how.
      </p>

      <h2 className={s.h2}>Contact</h2>
      <p className={s.p}>
        Questions about this policy? Reach out via{" "}
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
