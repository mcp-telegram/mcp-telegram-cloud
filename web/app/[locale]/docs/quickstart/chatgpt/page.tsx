import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CopyableUrl } from "@/components/docs/CopyableUrl";
import { StepCard, Stepper } from "@/components/docs/StepCard";
import { Troubleshooting } from "@/components/docs/Troubleshooting";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates, socialMetadata } from "@/lib/seo";
import s from "../../../doc.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const PATH = "/docs/quickstart/chatgpt";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "quickstart" });
  const canonical = canonicalForLocale(locale, PATH);
  const social = socialMetadata(locale, canonical);

  return {
    title: t("chatgptMetaTitle"),
    description: t("chatgptMetaDescription"),
    alternates: { canonical, languages: languageAlternates(PATH) },
    openGraph: {
      url: canonical,
      title: t("chatgptMetaTitle"),
      description: t("chatgptMetaDescription"),
      images: social.openGraph.images,
    },
    twitter: { ...social.twitter, title: t("chatgptMetaTitle"), description: t("chatgptMetaDescription") },
  };
}

export default async function QuickstartChatGPTPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Body />;
}

function Body() {
  const t = useTranslations("quickstart");
  const mcpUrl = `${config.mcpBaseUrl}/mcp`;

  const howTo = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: t("chatgptHeading"),
    description: t("chatgptIntro"),
    totalTime: "PT45S",
    step: [1, 2, 3].map((n) => ({
      "@type": "HowToStep",
      position: n,
      name: t(`chatgptStep${n}Title` as "chatgptStep1Title"),
      text: t(`chatgptStep${n}Desc` as "chatgptStep1Desc"),
    })),
  }).replace(/</g, "\\u003c");

  return (
    <main className={s.container}>
      <Link href="/docs/quickstart" className={s.backLink}>
        ← {t("backToOverview")}
      </Link>

      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD payload, manually escaped above. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: howTo }} />

      <h1 className={s.h1}>{t("chatgptHeading")}</h1>
      <p className={s.lead}>{t("chatgptIntro")}</p>

      <Stepper>
        <StepCard num={1} title={t("chatgptStep1Title")} description={t("chatgptStep1Desc")} />
        <StepCard num={2} title={t("chatgptStep2Title")} description={t("chatgptStep2Desc")}>
          <CopyableUrl url={mcpUrl} label={t("urlLabel")} copyLabel={t("copyLabel")} copiedLabel={t("copiedLabel")} />
        </StepCard>
        <StepCard num={3} title={t("chatgptStep3Title")} description={t("chatgptStep3Desc")} />
      </Stepper>

      <h2 className={s.h2}>{t("chatgptTroubleshootHeading")}</h2>
      <Troubleshooting
        items={[
          {
            title: t("chatgptTroubleshootDoubleQRTitle"),
            body: t("chatgptTroubleshootDoubleQRDesc"),
          },
          {
            title: t("chatgptTroubleshootLinkNotFoundTitle"),
            body: t("chatgptTroubleshootLinkNotFoundDesc"),
          },
        ]}
      />
    </main>
  );
}
