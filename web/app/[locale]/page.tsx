import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LangSwitcher } from "@/components/LangSwitcher";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../landing.module.css";

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const canonical = canonicalForLocale(locale, "/");
  const t = await getTranslations({ locale, namespace: "metadata" });
  const title = t("siteTitle");
  const description = t("siteDescription");
  return {
    title,
    description,
    alternates: { canonical, languages: languageAlternates("/") },
    openGraph: { url: canonical, title, description },
    twitter: { title, description },
  };
}

export default async function HomePage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <HomePageContent />;
}

function HomePageContent() {
  const tNav = useTranslations("nav");
  const tHero = useTranslations("hero");
  const tFeat = useTranslations("features");
  const tEx = useTranslations("examples");
  const tHow = useTranslations("howItWorks");
  const tFaq = useTranslations("faq");
  const tFooter = useTranslations("footer");
  const tMeta = useTranslations("metadata");

  // Escape `<` so a malicious BRAND_NAME/ISSUER cannot break out of the
  // <script> tag via `</script>`. Same guard as the Hono implementation.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: config.brandName,
    description: tMeta("siteDescription"),
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
          <a href="#features">{tNav("features")}</a>
          <Link href="/docs/quickstart">{tNav("quickstart")}</Link>
          <Link href="/examples">{tNav("examples")}</Link>
          <a href="#faq">{tNav("faq")}</a>
          <a href={config.sourceRepoUrl} className={s.navHideMobile}>
            {tNav("github")}
          </a>
          <LangSwitcher />
        </nav>
      </header>

      <section className={s.hero}>
        <h1 className={s.heroTitle}>
          {tHero("titleStart")} <span>{tHero("titleClaude")}</span> {tHero("titleAnd")}{" "}
          <span>{tHero("titleChatGPT")}</span>
        </h1>
        <p className={s.heroSubtitle}>{tHero("subtitle")}</p>
        <div>
          <Link className={s.cta} href="/docs/quickstart">
            {tHero("ctaQuickstart")}
          </Link>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section} id="features">
        <h2 className={s.sectionTitle}>{tFeat("heading")}</h2>
        <p className={s.sectionSubtitle}>{tFeat("subheading")}</p>

        <div className={s.featureGrid}>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>💬</div>
            <h3>{tFeat("readMessagesTitle")}</h3>
            <p>{tFeat("readMessagesDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>🔍</div>
            <h3>{tFeat("searchTitle")}</h3>
            <p>{tFeat("searchDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📊</div>
            <h3>{tFeat("analyticsTitle")}</h3>
            <p>{tFeat("analyticsDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📷</div>
            <h3>{tFeat("mediaTitle")}</h3>
            <p>{tFeat("mediaDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>👥</div>
            <h3>{tFeat("contactsTitle")}</h3>
            <p>{tFeat("contactsDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>✍️</div>
            <h3>{tFeat("writeTitle")}</h3>
            <p>{tFeat("writeDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>👥</div>
            <h3>{tFeat("multiAccountTitle")}</h3>
            <p>{tFeat("multiAccountDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📖</div>
            <h3>{tFeat("storiesTitle")}</h3>
            <p>{tFeat("storiesDesc")}</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📎</div>
            <h3>{tFeat("uploadsTitle")}</h3>
            <p>{tFeat("uploadsDesc")}</p>
          </div>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section}>
        <h2 className={s.sectionTitle}>{tEx("heading")}</h2>
        <p className={s.sectionSubtitle}>{tEx("subheading")}</p>

        <div className={s.featureGrid}>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>☀️</div>
            <h3>{tEx("morningTitle")}</h3>
            <p>"{tEx("morningPrompt")}"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>🔎</div>
            <h3>{tEx("findTitle")}</h3>
            <p>"{tEx("findPrompt")}"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📋</div>
            <h3>{tEx("extractTitle")}</h3>
            <p>"{tEx("extractPrompt")}"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>👤</div>
            <h3>{tEx("peopleTitle")}</h3>
            <p>"{tEx("peoplePrompt")}"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>📊</div>
            <h3>{tEx("overviewTitle")}</h3>
            <p>"{tEx("overviewPrompt")}"</p>
          </div>
          <div className={s.featureCard}>
            <div className={s.featureIcon}>🖼️</div>
            <h3>{tEx("mediaTitle")}</h3>
            <p>"{tEx("mediaPrompt")}"</p>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 24 }}>
          <Link href="/examples" className={s.ctaSecondary}>
            {tEx("ctaSeeAll")} →
          </Link>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section} id="how-it-works">
        <h2 className={s.sectionTitle}>{tHow("heading")}</h2>
        <p className={s.sectionSubtitle}>{tHow("subheading")}</p>

        <div className={s.stepsRow}>
          <div className={s.stepCard}>
            <h3>{tHow("step1Title")}</h3>
            <p>{tHow("step1Desc")}</p>
          </div>
          <div className={s.stepCard}>
            <h3>{tHow("step2Title")}</h3>
            <p>{tHow("step2Desc")}</p>
          </div>
          <div className={s.stepCard}>
            <h3>{tHow("step3Title")}</h3>
            <p>{tHow("step3Desc")}</p>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 24 }}>
          <Link href="/docs/quickstart" className={s.cta}>
            {tHow("ctaFullGuide")} →
          </Link>
        </div>
      </section>

      <hr className={s.divider} />

      <section className={s.section} id="faq">
        <h2 className={s.sectionTitle}>{tFaq("heading")}</h2>
        <p className={s.sectionSubtitle}>{tFaq("subheading")}</p>

        <div className={s.faqList}>
          <div className={s.faqItem}>
            <h3>{tFaq("safeQ")}</h3>
            <p>{tFaq("safeA")}</p>
          </div>
          <div className={s.faqItem}>
            <h3>{tFaq("readQ")}</h3>
            <p>
              {tFaq("readAStart")}{" "}
              <a href={`${config.sourceRepoUrl}/blob/main/SECURITY.md`} className={s.faqLink}>
                {tFaq("readALinkLabel")}
              </a>
              {tFaq("readAEnd")}
            </p>
          </div>
          <div className={s.faqItem}>
            <h3>{tFaq("protocolQ")}</h3>
            <p>{tFaq("protocolA")}</p>
          </div>
          <div className={s.faqItem}>
            <h3>{tFaq("disconnectQ")}</h3>
            <p>{tFaq("disconnectA")}</p>
          </div>
          <div className={s.faqItem}>
            <h3>{tFaq("multiAccountQ")}</h3>
            <p>{tFaq("multiAccountA")}</p>
          </div>
          <div className={s.faqItem}>
            <h3>{tFaq("chatgptQ")}</h3>
            <p>
              {tFaq("chatgptAStart")} <code className={s.faqCode}>{config.mcpBaseUrl}/mcp</code> {tFaq("chatgptAEnd")}
            </p>
          </div>
          <div className={s.faqItem}>
            <h3>{tFaq("openSourceQ")}</h3>
            <p>
              {tFaq("openSourceAStart")}{" "}
              <a href={config.sourceRepoUrl} className={s.faqLink}>
                {repoLabel}
              </a>
              {tFaq("openSourceAEnd")}
            </p>
          </div>
          {config.botUsername ? (
            <div className={s.faqItem}>
              <h3>{tFaq("botQ")}</h3>
              <p>
                {tFaq("botAStart")}{" "}
                <a href={`https://t.me/${config.botUsername}?start=subscribe`} className={s.faqLink}>
                  @{config.botUsername}
                </a>{" "}
                {tFaq("botAEnd")}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <hr className={s.divider} />

      <footer className={s.footer}>
        <p>
          {config.brandName} &mdash; <a href={config.sourceRepoUrl}>{tNav("github")}</a> &middot; {tFooter("mit")}{" "}
          &middot; <a href={config.issuesUrl}>{config.issuesLabel}</a> &middot;{" "}
          <Link href="/privacy">{tFooter("privacy")}</Link> &middot; <Link href="/terms">{tFooter("terms")}</Link>
        </p>
        <p className={s.footerSecond}>
          &copy; {new Date().getFullYear()} {config.brandName}. {tFooter("tagline")}
        </p>
      </footer>
    </>
  );
}
