import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FeatureGuide } from "@/components/docs/FeatureGuide";
import { canonicalForLocale, languageAlternates, socialMetadata } from "@/lib/seo";

type PageProps = { params: Promise<{ locale: string }> };

const PATH = "/docs/stories";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "featureGuides.stories" });
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

export default async function StoriesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <FeatureGuide slug="stories" stepCount={4} troubleshootCount={2} />;
}
