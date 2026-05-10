import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../landing.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const DESCRIPTION =
  "Connect your Telegram to Claude AI or ChatGPT. Read messages, search chats, get contacts — all from AI with one click.";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const canonical = canonicalForLocale(locale, "/");
  const title = `${config.brandName} — Your Telegram in Claude AI & ChatGPT`;
  return {
    title,
    description: DESCRIPTION,
    alternates: { canonical, languages: languageAlternates("/") },
    openGraph: { url: canonical, title, description: DESCRIPTION },
    twitter: { title, description: DESCRIPTION },
  };
}

export default async function HomePage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Escape `<` so a malicious BRAND_NAME/ISSUER cannot break out of the
  // <script> tag via `</script>`. Same guard as the Hono implementation.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: config.brandName,
    description:
      "Connect your Telegram to Claude AI or ChatGPT. Read messages, search chats, get contacts — all from AI.",
    url: config.issuer,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    license: "https://opensource.org/licenses/MIT",
  }).replace(/</g, "\\u003c");

  const repoLabel = config.sourceRepoUrl.replace(/^https?:\/\//, "");

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD payload, manually escaped above. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      <header className={s.header}>
        <div className={s.logo}>
          {/* biome-ignore lint/performance/noImgElement: served from Hono backend, not next/image-optimised. */}
          <img src="/icon.svg" alt="Telegram" width={28} height={28} />
          {config.brandName}
        </div>
        <nav className={s.nav}>
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#choice">Hosted or self-host</a>
          <a href="#faq">FAQ</a>
          <a href={config.sourceRepoUrl}>GitHub</a>
        </nav>
      </header>

      <section className={s.hero}>
        <h1 className={s.heroTitle}>
          Your Telegram in <span>Claude AI</span> &amp; <span>ChatGPT</span>
        </h1>
        <p className={s.heroSubtitle}>
          Read messages, search chats, track contacts and download media — all from Claude.ai or ChatGPT. Connect in 30
          seconds with a QR code.
        </p>
        <div>
          <a className={s.cta} href="#how-it-works">
            Connect Telegram
          </a>
          <a className={s.ctaSecondary} href={config.sourceRepoUrl}>
            Self-host
          </a>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section} id="features">
        <h2 className={s.sectionTitle}>What you can do</h2>
        <p className={s.sectionSubtitle}>Read-only tools — safe, private, no messages sent on your behalf</p>

        <div className={s.featureGrid}>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>💬</div>
            <h3>Read messages</h3>
            <p>Browse messages from any chat with date filtering and pagination</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>🔍</div>
            <h3>Search everything</h3>
            <p>Full-text search across chats, messages, contacts and channels</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📊</div>
            <h3>Chat analytics</h3>
            <p>Get chat info, member lists, unread counts and detailed metadata</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📷</div>
            <h3>View media</h3>
            <p>Download and view photos inline directly in AI conversations</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>👥</div>
            <h3>Contacts &amp; members</h3>
            <p>Access your contacts list and group/channel member lists</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>🔒</div>
            <h3>Read-only &amp; secure</h3>
            <p>Cannot send, edit or delete messages. Your account is safe</p>
          </div>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section}>
        <h2 className={s.sectionTitle}>What people ask</h2>
        <p className={s.sectionSubtitle}>Real prompts you can use right after connecting</p>

        <div className={s.featureGrid}>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>☀️</div>
            <h3>Morning briefing</h3>
            <p>"Summarize my unread messages and highlight anything urgent"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>🔎</div>
            <h3>Find anything</h3>
            <p>"Find messages about the project deadline in our work chat"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📋</div>
            <h3>Extract data</h3>
            <p>"List all links shared in the design channel this week"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>👤</div>
            <h3>People lookup</h3>
            <p>"Who are the most active members in our community group?"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📊</div>
            <h3>Chat overview</h3>
            <p>"Give me a summary of what happened in the team chat today"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>🖼️</div>
            <h3>Media review</h3>
            <p>"Show me the photos sent in the family chat yesterday"</p>
          </div>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section} id="how-it-works">
        <h2 className={s.sectionTitle}>How it works</h2>
        <p className={s.sectionSubtitle}>Three steps, 30 seconds, no API keys needed</p>

        <div className={s.stepsRow}>
          <div className={s.stepCard}>
            <h3>Add connector</h3>
            <p>Click "Connect" in Claude.ai or add as app in ChatGPT</p>
          </div>
          <div className={s.stepCard}>
            <h3>Scan QR code</h3>
            <p>Open Telegram → Settings → Devices → Link Desktop Device → Scan</p>
          </div>
          <div className={s.stepCard}>
            <h3>Start asking</h3>
            <p>Ask AI to read your chats, search messages, or summarize conversations</p>
          </div>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section} id="choice">
        <h2 className={s.sectionTitle}>Hosted or self-host</h2>
        <p className={s.sectionSubtitle}>Open source under MIT. Use the hosted instance, or run your own.</p>

        <div className={s.choiceGrid}>
          <div className={s.choiceCard}>
            <h3>Hosted</h3>
            <p className={s.choiceTagline}>One-click connect, maintained by the project.</p>
            <ul className={s.choiceFeatures}>
              <li>QR code login — no API keys to manage</li>
              <li>Read-only tool set, safe by design</li>
              <li>Daily fair-use cap to keep service healthy</li>
              <li>Service status updates via Telegram bot</li>
            </ul>
            <a className={s.choiceCta} href="#how-it-works">
              Connect now
            </a>
          </div>

          <div className={s.choiceCard}>
            <h3>Self-host</h3>
            <p className={s.choiceTagline}>Full control, your machine, your data.</p>
            <ul className={s.choiceFeatures}>
              <li>All tools — read and write</li>
              <li>No daily limits</li>
              <li>Your data never leaves your server</li>
              <li>Docker Compose + .env, ~10 minutes setup</li>
            </ul>
            <a className={s.choiceCta} href={config.sourceRepoUrl}>
              View on GitHub
            </a>
          </div>
        </div>

        <p className={s.subtleNote}>
          No tracking. No ads. Maintained by one person in spare time — please be patient with issues and PRs.
        </p>
      </section>

      <hr className={s.divider} />

      <section className={s.section} id="faq">
        <h2 className={s.sectionTitle}>FAQ</h2>
        <p className={s.sectionSubtitle}>Common questions about security and privacy</p>

        <div className={s.faqList}>
          <div className={s.faqItem}>
            <h3>Is it safe to connect my Telegram?</h3>
            <p>
              Yes. The hosted version is strictly read-only — it cannot send, edit, or delete any messages. Your account
              is used the same way as logging into Telegram Web or Desktop. You can disconnect at any time from
              Telegram's "Devices" settings.
            </p>
          </div>
          <div className={s.faqItem}>
            <h3>Can you read my messages on the server?</h3>
            <p>
              We don't store your messages. Each tool call fetches data directly from Telegram's API and returns it to
              the AI assistant. Your Telegram session key is stored on our server so the connector can keep working
              between requests, and is deleted whenever your session ends (see the next answer for the exact timing).
              Storage details and hardening guidance are in our{" "}
              <a href={`${config.sourceRepoUrl}/blob/main/SECURITY.md`} className={s.faqLink}>
                SECURITY.md
              </a>
              .
            </p>
          </div>
          <div className={s.faqItem}>
            <h3>How does it connect without the Bot API?</h3>
            <p>
              It uses MTProto — the same protocol Telegram's official apps use. You authenticate via QR code, just like
              linking a new device. From Telegram's perspective, it's another logged-in client.
            </p>
          </div>
          <div className={s.faqItem}>
            <h3>What happens when I disconnect?</h3>
            <p>
              If you explicitly remove the connector in Claude.ai or ChatGPT, the server logs the Telegram session out
              and deletes the session key right away. If you just close the AI app without revoking, the in-memory
              client is dropped immediately and the stored session key is kept briefly so you can resume seamlessly; if
              you don't reconnect within a short idle window (a few minutes), the server logs out and deletes the key
              automatically. You can also force a full revoke at any time from Telegram → Settings → Devices.
            </p>
          </div>
          <div className={s.faqItem}>
            <h3>Does it work with ChatGPT?</h3>
            <p>
              Yes. Add it as an app in ChatGPT Settings → Apps (Developer Mode). Use the URL{" "}
              <code className={s.faqCode}>{config.issuer}/mcp</code> with OAuth authentication. Works on Plus, Pro,
              Team, and Enterprise plans.
            </p>
          </div>
          <div className={s.faqItem}>
            <h3>Is the source code open?</h3>
            <p>
              The server is fully open-source (MIT license) at{" "}
              <a href={config.sourceRepoUrl} className={s.faqLink}>
                {repoLabel}
              </a>
              . You can self-host it for free with full read+write access.
            </p>
          </div>
          {config.botUsername ? (
            <div className={s.faqItem}>
              <h3>How will I know about service updates?</h3>
              <p>
                Subscribe to{" "}
                <a href={`https://t.me/${config.botUsername}?start=subscribe`} className={s.faqLink}>
                  @{config.botUsername}
                </a>{" "}
                to get notified about service status, breaking changes and new releases. Send /stop any time to
                unsubscribe.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <hr className={s.divider} />

      <footer className={s.footer}>
        <p>
          {config.brandName} &mdash; <a href={config.sourceRepoUrl}>GitHub</a> &middot; MIT licensed &middot;{" "}
          <a href={config.issuesUrl}>{config.issuesLabel}</a> &middot; <a href="/privacy">Privacy</a> &middot;{" "}
          <a href="/terms">Terms</a>
        </p>
        <p className={s.footerSecond}>
          &copy; {new Date().getFullYear()} {config.brandName}. Read-only Telegram access for Claude AI &amp; ChatGPT.
        </p>
      </footer>
    </>
  );
}
