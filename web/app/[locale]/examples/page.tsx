import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ExampleCard } from "@/components/examples/ExampleCard";
import { LangSwitcher } from "@/components/LangSwitcher";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../doc.module.css";
import h from "../docs/header.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const PATH = "/examples";

const ITEMS = [
  "morning",
  "weeklyDigest",
  "findDeadline",
  "findFiles",
  "linksThisWeek",
  "extractActions",
  "topMembers",
  "whoMentioned",
  "chatActivity",
  "unreadByChat",
  "photosFamily",
  "voiceTranscripts",
] as const;

type Category = "briefing" | "search" | "analytics" | "extract" | "people" | "media";

type CategoryKey = `cat_${Category}`;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "examplesPage" });
  const canonical = canonicalForLocale(locale, PATH);
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical, languages: languageAlternates(PATH) },
    openGraph: { url: canonical, title: t("metaTitle"), description: t("metaDescription") },
    twitter: { title: t("metaTitle"), description: t("metaDescription") },
  };
}

export default async function ExamplesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Body />;
}

function Body() {
  const t = useTranslations("examplesPage");

  return (
    <>
      <header className={h.header}>
        <Link href="/" className={h.brand}>
          {/* biome-ignore lint/performance/noImgElement: served from Hono backend, not next/image-optimised. */}
          <img src="/icon.svg" alt="" width={24} height={24} />
          {config.brandName}
        </Link>
        <LangSwitcher />
      </header>

      <main className={s.container}>
        <h1 className={s.h1}>{t("heading")}</h1>
        <p className={s.lead}>{t("subheading")}</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 18 }}>
          {ITEMS.map((id) => {
            const category = t(`items.${id}.category` as `items.morning.category`) as Category;
            return (
              <ExampleCard
                key={id}
                title={t(`items.${id}.title` as `items.morning.title`)}
                description={t(`items.${id}.description` as `items.morning.description`)}
                prompt={t(`items.${id}.prompt` as `items.morning.prompt`)}
                category={t(`cat_${category}` as CategoryKey)}
                copyLabel={t("tryThis")}
                copiedLabel={t("tryThis")}
              />
            );
          })}
        </div>
      </main>
    </>
  );
}
