import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CopyableUrl } from "@/components/docs/CopyableUrl";
import { StepCard } from "@/components/docs/StepCard";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../../../doc.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const PATH = "/docs/quickstart/claude";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "quickstart" });
  const canonical = canonicalForLocale(locale, PATH);
  return {
    title: t("claudeMetaTitle"),
    description: t("claudeMetaDescription"),
    alternates: { canonical, languages: languageAlternates(PATH) },
    openGraph: { url: canonical, title: t("claudeMetaTitle"), description: t("claudeMetaDescription") },
    twitter: { title: t("claudeMetaTitle"), description: t("claudeMetaDescription") },
  };
}

export default async function QuickstartClaudePage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Body />;
}

function Body() {
  const t = useTranslations("quickstart");
  const mcpUrl = `${config.issuer}/mcp`;

  // HowTo schema for SERP rich snippets.
  const howTo = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: t("claudeHeading"),
    description: t("claudeIntro"),
    totalTime: "PT30S",
    step: [1, 2, 3, 4, 5].map((n) => ({
      "@type": "HowToStep",
      position: n,
      name: t(`claudeStep${n}Title` as "claudeStep1Title"),
      text: t(`claudeStep${n}Desc` as "claudeStep1Desc"),
    })),
  }).replace(/</g, "\\u003c");

  return (
    <main className={s.container}>
      <Link href="/docs/quickstart" className={s.backLink}>
        ← {t("backToOverview")}
      </Link>

      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD payload, manually escaped above. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: howTo }} />

      <h1 className={s.h1}>{t("claudeHeading")}</h1>
      <p className={s.lead}>{t("claudeIntro")}</p>

      <StepCard num={1} title={t("claudeStep1Title")} description={t("claudeStep1Desc")} />
      <StepCard num={2} title={t("claudeStep2Title")} description={t("claudeStep2Desc")} />
      <StepCard num={3} title={t("claudeStep3Title")} description={t("claudeStep3Desc")}>
        <CopyableUrl url={mcpUrl} label={t("urlLabel")} copyLabel={t("copyLabel")} copiedLabel={t("copiedLabel")} />
      </StepCard>
      <StepCard num={4} title={t("claudeStep4Title")} description={t("claudeStep4Desc")} />
      <StepCard num={5} title={t("claudeStep5Title")} description={t("claudeStep5Desc")} />

      <h2 className={s.h2}>{t("claudeTroubleshootHeading")}</h2>
      <div className={s.tsList}>
        <div className={s.tsItem}>
          <h3>{t("claudeTroubleshootQRTitle")}</h3>
          <p>{t("claudeTroubleshootQRDesc")}</p>
        </div>
        <div className={s.tsItem}>
          <h3>{t("claudeTroubleshootDisconnectedTitle")}</h3>
          <p>{t("claudeTroubleshootDisconnectedDesc")}</p>
        </div>
        <div className={s.tsItem}>
          <h3>{t("claudeTroubleshootChatsTitle")}</h3>
          <p>{t("claudeTroubleshootChatsDesc")}</p>
        </div>
      </div>
    </main>
  );
}
