import type { FC } from "hono/jsx";
import { config } from "../config.js";
import { landing, landingReset } from "../styles.js";
import { Layout } from "./Layout.js";

const contactHref = config.contactEmail
  ? `mailto:${config.contactEmail}`
  : config.contactTelegram
    ? `https://t.me/${config.contactTelegram}`
    : "#";

export const LandingPage: FC = () => {
  return (
    <Layout
      title={`${config.brandName} — Your Telegram in Claude AI & ChatGPT`}
      description="Connect your Telegram to Claude AI or ChatGPT. Read messages, search chats, get contacts — all from AI with one click."
      canonicalUrl={config.issuer}
      globalCss={landingReset}
    >
      {/* ── Structured Data ──────────────────────────────────────── */}
      {/* Escape `<` in the JSON payload so a malicious BRAND_NAME/ISSUER
          cannot break out of the <script> via `</script>`. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: config.brandName,
            description:
              "Connect your Telegram to Claude AI or ChatGPT. Read messages, search chats, get contacts — all from AI.",
            url: config.issuer,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Any",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "USD",
            },
          }).replace(/</g, "\\u003c"),
        }}
      />

      {/* ── Header ──────────────────────────────────────────────── */}
      <header class={landing.header}>
        <div class={landing.logo}>
          <img src="/icon.svg" alt="Telegram" width="28" height="28" />
          {config.brandName}
        </div>
        <nav class={landing.nav}>
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
          <a href="https://github.com/mcp-telegram/mcp-telegram">GitHub</a>
        </nav>
      </header>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <section class={landing.hero}>
        <h1 class={landing.heroTitle}>
          Your Telegram in <span>Claude AI</span> &amp; <span>ChatGPT</span>
        </h1>
        <p class={landing.heroSubtitle}>
          Read messages, search chats, track contacts and download media — all from Claude.ai or ChatGPT. Connect in 30
          seconds with a QR code.
        </p>
        <div>
          <a class={landing.cta} href="#how-it-works">
            Connect Telegram
          </a>
          <a class={landing.ctaSecondary} href="https://github.com/mcp-telegram/mcp-telegram">
            Self-host (free)
          </a>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── Features ────────────────────────────────────────────── */}
      <section class={landing.section} id="features">
        <h2 class={landing.sectionTitle}>What you can do</h2>
        <p class={landing.sectionSubtitle}>Read-only tools — safe, private, no messages sent on your behalf</p>

        <div class={landing.featureGrid}>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>💬</div>
            <h3>Read messages</h3>
            <p>Browse messages from any chat with date filtering and pagination</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>🔍</div>
            <h3>Search everything</h3>
            <p>Full-text search across chats, messages, contacts and channels</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>📊</div>
            <h3>Chat analytics</h3>
            <p>Get chat info, member lists, unread counts and detailed metadata</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>📷</div>
            <h3>View media</h3>
            <p>Download and view photos inline directly in AI conversations</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>👥</div>
            <h3>Contacts &amp; members</h3>
            <p>Access your contacts list and group/channel member lists</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>🔒</div>
            <h3>Read-only &amp; secure</h3>
            <p>Cannot send, edit or delete messages. Your account is safe</p>
          </div>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── Use cases ─────────────────────────────────────────────── */}
      <section class={landing.section}>
        <h2 class={landing.sectionTitle}>What people ask</h2>
        <p class={landing.sectionSubtitle}>Real prompts you can use right after connecting</p>

        <div class={landing.featureGrid}>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>☀️</div>
            <h3>Morning briefing</h3>
            <p>"Summarize my unread messages and highlight anything urgent"</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>🔎</div>
            <h3>Find anything</h3>
            <p>"Find messages about the project deadline in our work chat"</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>📋</div>
            <h3>Extract data</h3>
            <p>"List all links shared in the design channel this week"</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>👤</div>
            <h3>People lookup</h3>
            <p>"Who are the most active members in our community group?"</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>📊</div>
            <h3>Chat overview</h3>
            <p>"Give me a summary of what happened in the team chat today"</p>
          </div>
          <div class={landing.featureCard}>
            <div class={landing.featureIcon}>🖼️</div>
            <h3>Media review</h3>
            <p>"Show me the photos sent in the family chat yesterday"</p>
          </div>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── How it works ────────────────────────────────────────── */}
      <section class={landing.section} id="how-it-works">
        <h2 class={landing.sectionTitle}>How it works</h2>
        <p class={landing.sectionSubtitle}>Three steps, 30 seconds, no API keys needed</p>

        <div class={landing.stepsRow}>
          <div class={landing.stepCard}>
            <h3>Add connector</h3>
            <p>Click "Connect" in Claude.ai or add as app in ChatGPT</p>
          </div>
          <div class={landing.stepCard}>
            <h3>Scan QR code</h3>
            <p>Open Telegram → Settings → Devices → Link Desktop Device → Scan</p>
          </div>
          <div class={landing.stepCard}>
            <h3>Start asking</h3>
            <p>Ask AI to read your chats, search messages, or summarize conversations</p>
          </div>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── Pricing ─────────────────────────────────────────────── */}
      <section class={landing.section} id="pricing">
        <h2 class={landing.sectionTitle}>Pricing</h2>
        <p class={landing.sectionSubtitle}>Start free, upgrade when you need more</p>

        <div class={landing.pricingGrid}>
          <div class={landing.pricingCard}>
            <h3>Free</h3>
            <div class={landing.pricingPrice}>$0</div>
            <p class={landing.pricingDesc}>For trying it out</p>
            <ul class={landing.pricingFeatures}>
              <li>1 Telegram account</li>
              <li>100 tool calls / day</li>
              <li>All tools included</li>
              <li>QR code login</li>
            </ul>
            <a class={landing.pricingCtaOutline} href="#how-it-works">
              Get started
            </a>
          </div>

          <div class={landing.pricingHighlight}>
            <div class={landing.badge}>Coming soon</div>
            <h3>Pro</h3>
            <div class={landing.pricingPrice}>
              $9<span>/mo</span>
            </div>
            <p class={landing.pricingDesc}>For daily use</p>
            <ul class={landing.pricingFeatures}>
              <li>1 Telegram account</li>
              <li>5,000 tool calls / day</li>
              <li>All tools included</li>
              <li>Priority support</li>
            </ul>
            <a class={landing.pricingCtaOutline} href={contactHref}>
              Join waitlist
            </a>
          </div>

          <div class={landing.pricingCard}>
            <h3>Team</h3>
            <div class={landing.pricingPrice}>
              $29<span>/mo</span>
            </div>
            <p class={landing.pricingDesc}>For teams — coming soon</p>
            <ul class={landing.pricingFeatures}>
              <li>5 Telegram accounts</li>
              <li>20,000 tool calls / day</li>
              <li>All tools included</li>
              <li>Priority support</li>
            </ul>
            <a class={landing.pricingCtaOutline} href={contactHref}>
              Join waitlist
            </a>
          </div>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── FAQ ───────────────────────────────────────────────────── */}
      <section class={landing.section} id="faq">
        <h2 class={landing.sectionTitle}>FAQ</h2>
        <p class={landing.sectionSubtitle}>Common questions about security and privacy</p>

        <div class={landing.faqList}>
          <div class={landing.faqItem}>
            <h3>Is it safe to connect my Telegram?</h3>
            <p>
              Yes. The hosted version is strictly read-only — it cannot send, edit, or delete any messages. Your account
              is used the same way as logging into Telegram Web or Desktop. You can disconnect at any time from
              Telegram's "Devices" settings.
            </p>
          </div>
          <div class={landing.faqItem}>
            <h3>Can you read my messages on the server?</h3>
            <p>
              We don't store your messages. Each tool call fetches data directly from Telegram's API and returns it to
              the AI assistant. Your session key is encrypted in our database and deleted when you disconnect.
            </p>
          </div>
          <div class={landing.faqItem}>
            <h3>How does it connect without the Bot API?</h3>
            <p>
              It uses MTProto — the same protocol Telegram's official apps use. You authenticate via QR code, just like
              linking a new device. From Telegram's perspective, it's another logged-in client.
            </p>
          </div>
          <div class={landing.faqItem}>
            <h3>What happens when I disconnect?</h3>
            <p>
              Your Telegram session is immediately terminated (logged out) and the session key is deleted from our
              server. No residual access remains.
            </p>
          </div>
          <div class={landing.faqItem}>
            <h3>Does it work with ChatGPT?</h3>
            <p>
              Yes. Add it as an app in ChatGPT Settings → Apps (Developer Mode). Use the URL{" "}
              <code style="background: #f0f0f0; padding: 2px 6px; border-radius: 4px">{config.issuer}/mcp</code> with
              OAuth authentication. Works on Plus, Pro, Team, and Enterprise plans.
            </p>
          </div>
          <div class={landing.faqItem}>
            <h3>Is the source code open?</h3>
            <p>
              The core MCP server is fully open-source (MIT license) at{" "}
              <a href="https://github.com/mcp-telegram/mcp-telegram" style="color: #007AFF">
                github.com/mcp-telegram/mcp-telegram
              </a>
              . You can self-host it for free with full read+write access.
            </p>
          </div>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer class={landing.footer}>
        <p>
          {config.brandName} &mdash; <a href="https://github.com/mcp-telegram/mcp-telegram">Open-source core</a>{" "}
          &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a>
        </p>
        <p style="margin-top: 8px">
          &copy; {new Date().getFullYear()} {config.brandName}. Read-only Telegram access for Claude AI &amp; ChatGPT.
        </p>
      </footer>
    </Layout>
  );
};
