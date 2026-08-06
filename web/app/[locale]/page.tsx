import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  TbBook,
  TbBrandGithub,
  TbChartBar,
  TbChartPie,
  TbClipboardList,
  TbIdBadge2,
  TbMessageCircle,
  TbPaperclip,
  TbPencil,
  TbPhoto,
  TbSearch,
  TbSun,
  TbUserSearch,
  TbUsers,
  TbZoom,
} from "react-icons/tb";
import { ChatDemo } from "@/components/landing/ChatDemo";
import { FaqAccordion, type FaqEntry } from "@/components/landing/FaqAccordion";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates, socialMetadata } from "@/lib/seo";
import s from "../landing.module.css";

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const canonical = canonicalForLocale(locale, "/");
  const t = await getTranslations({ locale, namespace: "metadata" });
  const title = t("siteTitle");
  const description = t("siteDescription");
  const social = socialMetadata(locale, canonical);

  return {
    title,
    description,
    alternates: { canonical, languages: languageAlternates("/") },
    openGraph: { url: canonical, title, description, images: social.openGraph.images },
    twitter: { ...social.twitter, title, description },
  };
}

export default async function HomePage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <HomePageContent />;
}

/** Feature cards: message key ↔ icon ↔ gradient token. */
const FEATURES = [
  { key: "readMessages", Icon: TbMessageCircle, gradient: "var(--tg-grad-read)" },
  { key: "search", Icon: TbSearch, gradient: "var(--tg-grad-search)" },
  { key: "analytics", Icon: TbChartBar, gradient: "var(--tg-grad-analytics)" },
  { key: "media", Icon: TbPhoto, gradient: "var(--tg-grad-media)" },
  { key: "contacts", Icon: TbUsers, gradient: "var(--tg-grad-contacts)" },
  { key: "write", Icon: TbPencil, gradient: "var(--tg-grad-write)" },
  { key: "multiAccount", Icon: TbIdBadge2, gradient: "var(--tg-grad-multi)" },
  { key: "stories", Icon: TbBook, gradient: "var(--tg-grad-stories)" },
  { key: "uploads", Icon: TbPaperclip, gradient: "var(--tg-grad-uploads)" },
] as const;

/** Landing example prompts: message key ↔ icon. */
const EXAMPLES = [
  { key: "morning", Icon: TbSun },
  { key: "find", Icon: TbZoom },
  { key: "extract", Icon: TbClipboardList },
  { key: "people", Icon: TbUserSearch },
  { key: "overview", Icon: TbChartPie },
  { key: "media", Icon: TbPhoto },
] as const;

/** "How it works" steps. Spelled out rather than built from an index so
 * next-intl can type-check each key against messages/en.json. */
const STEPS = [
  { title: "step1Title", desc: "step1Desc" },
  { title: "step2Title", desc: "step2Desc" },
  { title: "step3Title", desc: "step3Desc" },
] as const;

const CLIENT_CHIPS = ["Claude.ai", "ChatGPT", "Cursor", "Hermes CLI"];

function HomePageContent() {
  const tHero = useTranslations("hero");
  const tFeat = useTranslations("features");
  const tEx = useTranslations("examples");
  const tHow = useTranslations("howItWorks");
  const tFaq = useTranslations("faq");
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

  const faqItems: FaqEntry[] = [
    { question: tFaq("safeQ"), answer: tFaq("safeA") },
    {
      question: tFaq("readQ"),
      answer: (
        <>
          {tFaq("readAStart")} <a href={`${config.sourceRepoUrl}/blob/main/SECURITY.md`}>{tFaq("readALinkLabel")}</a>
          {tFaq("readAEnd")}
        </>
      ),
    },
    { question: tFaq("protocolQ"), answer: tFaq("protocolA") },
    { question: tFaq("disconnectQ"), answer: tFaq("disconnectA") },
    { question: tFaq("multiAccountQ"), answer: tFaq("multiAccountA") },
    {
      question: tFaq("chatgptQ"),
      answer: (
        <>
          {tFaq("chatgptAStart")} <code className={s.faqCode}>{config.mcpBaseUrl}/mcp</code> {tFaq("chatgptAEnd")}
        </>
      ),
    },
    {
      question: tFaq("openSourceQ"),
      answer: (
        <>
          {tFaq("openSourceAStart")} <a href={config.sourceRepoUrl}>{repoLabel}</a>
          {tFaq("openSourceAEnd")}
        </>
      ),
    },
  ];

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD payload, manually escaped above. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      <SiteHeader />

      <div className={s.container}>
        <section className={s.hero}>
          <div className={s.heroCopy}>
            <span className={s.badge}>
              <span className={s.badgeDot} />
              MCP · MTProto · Open Source
            </span>

            <h1 className={s.heroTitle}>
              {tHero("titleStart")} <span>{tHero("titleClaude")}</span> {tHero("titleAnd")}{" "}
              <span>{tHero("titleChatGPT")}</span>
            </h1>

            <p className={s.heroSubtitle}>{tHero("subtitle")}</p>

            <div className={s.ctaRow}>
              <Link className={s.ctaPrimary} href="/docs/quickstart">
                {tHero("ctaQuickstart")}
              </Link>
              <a className={s.ctaSecondary} href={config.sourceRepoUrl}>
                <TbBrandGithub size={19} aria-hidden />
                GitHub · MIT
              </a>
            </div>

            <div className={s.clientChips}>
              {CLIENT_CHIPS.map((chip) => (
                <span key={chip} className={s.clientChip}>
                  {chip}
                </span>
              ))}
            </div>
          </div>

          <ChatDemo />
        </section>
      </div>

      <section className={`${s.section} ${s.sectionAlt}`} id="features">
        <div className={s.container}>
          <h2 className={s.sectionTitle}>{tFeat("heading")}</h2>
          <p className={s.sectionSubtitle}>{tFeat("subheading")}</p>

          <div className={`${s.featureGrid} ${s.sectionBody}`}>
            {FEATURES.map(({ key, Icon, gradient }) => (
              <div key={key} className={s.featureCard}>
                <div className={s.featureIcon} style={{ background: gradient }}>
                  <Icon size={23} aria-hidden />
                </div>
                <h3>{tFeat(`${key}Title`)}</h3>
                <p>{tFeat(`${key}Desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.container}>
          <h2 className={s.sectionTitle}>{tEx("heading")}</h2>
          <p className={s.sectionSubtitle}>{tEx("subheading")}</p>

          <div className={`${s.exampleGrid} ${s.sectionBody}`}>
            {EXAMPLES.map(({ key, Icon }) => (
              <div key={key}>
                <div className={s.exampleLabel}>
                  <Icon size={16} color="var(--tg-link)" aria-hidden />
                  {tEx(`${key}Title`)}
                </div>
                <p className={s.examplePrompt}>“{tEx(`${key}Prompt`)}”</p>
              </div>
            ))}
          </div>

          <div className={s.centerCta}>
            <Link href="/examples" className={s.ctaSecondary}>
              {tEx("ctaSeeAll")} →
            </Link>
          </div>
        </div>
      </section>

      <section className={`${s.section} ${s.sectionAlt}`} id="how-it-works">
        <div className={s.container}>
          <h2 className={s.sectionTitle}>{tHow("heading")}</h2>
          <p className={s.sectionSubtitle}>{tHow("subheading")}</p>

          <div className={`${s.stepsRow} ${s.sectionBody}`}>
            {STEPS.map((step, i) => (
              <div key={step.title} className={s.stepCard}>
                <span className={s.stepNumber}>{i + 1}</span>
                <h3>{tHow(step.title)}</h3>
                <p>{tHow(step.desc)}</p>
              </div>
            ))}
          </div>

          <div className={s.centerCta}>
            <Link href="/docs/quickstart" className={s.ctaPrimary}>
              {tHow("ctaFullGuide")} →
            </Link>
          </div>
        </div>
      </section>

      <section className={s.section} id="faq">
        <div className={s.container}>
          <h2 className={s.sectionTitle}>{tFaq("heading")}</h2>
          <p className={s.sectionSubtitle}>{tFaq("subheading")}</p>
          <div className={s.sectionBody}>
            <FaqAccordion items={faqItems} />
          </div>
        </div>
      </section>

      <div className={s.finalCta}>
        <h2 className={s.finalCtaTitle}>
          {tHero("titleStart")} {tHero("titleClaude")} {tHero("titleAnd")} {tHero("titleChatGPT")}
        </h2>
        <p className={s.finalCtaSubtitle}>{tHow("subheading")}</p>
        <Link href="/docs/quickstart" className={s.finalCtaButton}>
          {tHero("ctaQuickstart")}
        </Link>
      </div>

      <SiteFooter />
    </>
  );
}
