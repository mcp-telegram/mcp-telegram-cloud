import type { FC } from "hono/jsx";
import { landing, landingReset } from "../styles.js";
import { Layout } from "./Layout.js";

export const LandingPage: FC = () => {
  return (
    <Layout
      title="MCP Telegram — Your Telegram in Claude AI"
      description="Connect your Telegram to Claude AI. Read messages, search chats, get contacts — all from Claude.ai with one click."
      globalCss={landingReset}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <header class={landing.header}>
        <div class={landing.logo}>
          <img src="/icon.svg" alt="Telegram" width="28" height="28" />
          MCP Telegram
        </div>
        <nav class={landing.nav}>
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
          <a href="https://github.com/overpod/mcp-telegram">GitHub</a>
        </nav>
      </header>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <section class={landing.hero}>
        <h1 class={landing.heroTitle}>
          Your Telegram in <span>Claude AI</span>
        </h1>
        <p class={landing.heroSubtitle}>
          Read messages, search chats, track contacts and download media — all from Claude.ai. Connect in 30 seconds
          with a QR code.
        </p>
        <div>
          <a class={landing.cta} href="/login">
            Connect Telegram
          </a>
          <a class={landing.ctaSecondary} href="https://github.com/overpod/mcp-telegram">
            Self-host (free)
          </a>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── Features ────────────────────────────────────────────── */}
      <section class={landing.section} id="features">
        <h2 class={landing.sectionTitle}>What you can do</h2>
        <p class={landing.sectionSubtitle}>10 read-only tools — safe, private, no messages sent on your behalf</p>

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
            <p>Download and view photos inline directly in Claude conversations</p>
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

      {/* ── Tools ───────────────────────────────────────────────── */}
      <section class={landing.section}>
        <h2 class={landing.sectionTitle}>10 MCP Tools</h2>
        <p class={landing.sectionSubtitle}>Each tool is available as an MCP action in Claude.ai</p>

        <div class={landing.toolsGrid}>
          <div class={landing.toolItem}>
            <code>telegram-status</code> Check connection
          </div>
          <div class={landing.toolItem}>
            <code>telegram-list-chats</code> List dialogs
          </div>
          <div class={landing.toolItem}>
            <code>telegram-read-messages</code> Read messages
          </div>
          <div class={landing.toolItem}>
            <code>telegram-search-chats</code> Search chats
          </div>
          <div class={landing.toolItem}>
            <code>telegram-search-messages</code> Search messages
          </div>
          <div class={landing.toolItem}>
            <code>telegram-get-unread</code> Unread chats
          </div>
          <div class={landing.toolItem}>
            <code>telegram-get-chat-info</code> Chat details
          </div>
          <div class={landing.toolItem}>
            <code>telegram-get-chat-members</code> Members list
          </div>
          <div class={landing.toolItem}>
            <code>telegram-get-contacts</code> Contacts
          </div>
          <div class={landing.toolItem}>
            <code>telegram-download-media</code> Download media
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
            <p>Click "Connect" in Claude.ai integrations or use the link below</p>
          </div>
          <div class={landing.stepCard}>
            <h3>Scan QR code</h3>
            <p>Open Telegram → Settings → Devices → Link Desktop Device → Scan</p>
          </div>
          <div class={landing.stepCard}>
            <h3>Start asking</h3>
            <p>Ask Claude to read your chats, search messages, or summarize conversations</p>
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
              <li>All 10 tools</li>
              <li>QR code login</li>
            </ul>
            <a class={landing.pricingCtaOutline} href="/login">
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
              <li>All 10 tools</li>
              <li>Priority support</li>
            </ul>
            <a class={landing.pricingCtaOutline} href="mailto:overpod@yandex.ru">
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
              <li>All 10 tools</li>
              <li>Priority support</li>
            </ul>
            <a class={landing.pricingCtaOutline} href="mailto:overpod@yandex.ru">
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
              Claude. Your session key is encrypted in our database and deleted when you disconnect.
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
            <h3>Is the source code open?</h3>
            <p>
              The core MCP server is fully open-source (MIT license) at{" "}
              <a href="https://github.com/overpod/mcp-telegram" style="color: #007AFF">
                github.com/overpod/mcp-telegram
              </a>
              . You can self-host it for free with full read+write access (20 tools).
            </p>
          </div>
        </div>
      </section>

      <hr class={landing.divider} />

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer class={landing.footer}>
        <p>
          MCP Telegram Cloud &mdash; <a href="https://github.com/overpod/mcp-telegram">Open-source core</a> &middot;{" "}
          <a href="/login">Login</a> &middot; <a href="/health">Status</a>
        </p>
        <p style="margin-top: 8px">&copy; 2026 overpod. Read-only Telegram access for Claude AI.</p>
      </footer>
    </Layout>
  );
};
