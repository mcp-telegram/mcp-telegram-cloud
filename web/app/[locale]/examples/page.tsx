import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { type ExampleItem, FilterableExamples } from "@/components/examples/FilterableExamples";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { canonicalForLocale, languageAlternates, socialMetadata } from "@/lib/seo";
import s from "../doc.module.css";

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

/** Filter chip order — matches the categories used by ITEMS above. */
const CATEGORIES = ["briefing", "search", "extract", "people", "analytics", "media"] as const;

type CategoryKey = `cat_${Category}`;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "examplesPage" });
  const canonical = canonicalForLocale(locale, PATH);
  const social = socialMetadata(locale, canonical);

  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical, languages: languageAlternates(PATH) },
    openGraph: {
      url: canonical,
      title: t("metaTitle"),
      description: t("metaDescription"),
      images: social.openGraph.images,
    },
    twitter: { ...social.twitter, title: t("metaTitle"), description: t("metaDescription") },
  };
}

export default async function ExamplesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Body />;
}

function Body() {
  const t = useTranslations("examplesPage");
  // "Copied!" lives in the quickstart namespace — the copy button shares it.
  const tQuick = useTranslations("quickstart");

  const items: ExampleItem[] = ITEMS.map((id) => {
    const category = t(`items.${id}.category` as `items.morning.category`) as Category;
    return {
      id,
      title: t(`items.${id}.title` as `items.morning.title`),
      description: t(`items.${id}.description` as `items.morning.description`),
      prompt: t(`items.${id}.prompt` as `items.morning.prompt`),
      category,
      categoryLabel: t(`cat_${category}` as CategoryKey),
    };
  });

  const categories = CATEGORIES.map((id) => ({ id, label: t(`cat_${id}` as CategoryKey) }));

  return (
    <>
      <SiteHeader />

      <main className={s.container}>
        <h1 className={s.h1}>{t("heading")}</h1>
        <p className={s.lead}>{t("subheading")}</p>

        <FilterableExamples
          items={items}
          categories={categories}
          allLabel={t("catAll")}
          copyLabel={t("tryThis")}
          copiedLabel={tQuick("copiedLabel")}
        />
      </main>

      <SiteFooter />
    </>
  );
}
