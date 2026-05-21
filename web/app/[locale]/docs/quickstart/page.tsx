import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PlatformTabs } from "@/components/docs/PlatformTabs";
import { Link } from "@/i18n/navigation";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../../doc.module.css";

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "quickstart" });
  const canonical = canonicalForLocale(locale, "/docs/quickstart");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical, languages: languageAlternates("/docs/quickstart") },
    openGraph: { url: canonical, title: t("metaTitle"), description: t("metaDescription") },
    twitter: { title: t("metaTitle"), description: t("metaDescription") },
  };
}

export default async function QuickstartOverviewPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Body />;
}

function Body() {
  const t = useTranslations("quickstart");
  const tDiscover = useTranslations("featureGuides.discover");

  return (
    <main className={s.container}>
      <h1 className={s.h1}>{t("heading")}</h1>
      <p className={s.lead}>{t("subheading")}</p>

      <PlatformTabs
        tabs={[
          {
            href: "/docs/quickstart/claude",
            title: t("tabClaudeTitle"),
            description: t("tabClaudeDesc"),
            cta: t("tabClaudeCta"),
          },
          {
            href: "/docs/quickstart/chatgpt",
            title: t("tabChatGPTTitle"),
            description: t("tabChatGPTDesc"),
            cta: t("tabChatGPTCta"),
          },
        ]}
      />

      <p className={s.note}>{t("needAccount")}</p>

      <p className={s.note}>
        {t("oauthDocsHint")} <Link href="/docs/oauth">{t("oauthDocsLink")}</Link>
      </p>

      <h2 className={s.h2}>{tDiscover("heading")}</h2>
      <p className={s.lead}>{tDiscover("lead")}</p>
      <PlatformTabs
        tabs={[
          {
            href: "/docs/multi-account",
            title: tDiscover("multiAccountTitle"),
            description: tDiscover("multiAccountDesc"),
            cta: tDiscover("cta"),
          },
          {
            href: "/docs/stories",
            title: tDiscover("storiesTitle"),
            description: tDiscover("storiesDesc"),
            cta: tDiscover("cta"),
          },
          {
            href: "/docs/uploads",
            title: tDiscover("uploadsTitle"),
            description: tDiscover("uploadsDesc"),
            cta: tDiscover("cta"),
          },
        ]}
      />
    </main>
  );
}
