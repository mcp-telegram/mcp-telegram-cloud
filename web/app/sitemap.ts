import type { MetadataRoute } from "next";
import { defaultLocale, indexableLocales } from "@/lib/locales";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";

/** Sitemap with hreflang alternates for every indexable locale × every page.
 *
 * Tier 3 locales are excluded — they serve EN content at runtime via
 * `i18n/request.ts` fallback, so listing them with hreflang alternates would
 * mislead crawlers. They remain reachable via direct URL.
 *
 * Output is 20 indexable locales (Tier 1 + Tier 2) × 8 paths = 160 entries.
 * Default locale (en) is at the un-prefixed URL (`/`), others at `/<locale>/...`. */

const PAGES: { path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }[] = [
  { path: "/", changeFrequency: "monthly", priority: 1 },
  { path: "/docs/quickstart", changeFrequency: "monthly", priority: 0.9 },
  { path: "/docs/quickstart/claude", changeFrequency: "monthly", priority: 0.85 },
  { path: "/docs/quickstart/chatgpt", changeFrequency: "monthly", priority: 0.85 },
  { path: "/docs/oauth", changeFrequency: "monthly", priority: 0.8 },
  { path: "/examples", changeFrequency: "monthly", priority: 0.85 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const page of PAGES) {
    const alternates = languageAlternates(page.path);
    for (const locale of indexableLocales) {
      entries.push({
        url: canonicalForLocale(locale.code, page.path),
        lastModified: now,
        changeFrequency: page.changeFrequency,
        // Boost the default-locale (en) entry priority slightly so it stays
        // primary signal; localised entries inherit the same alternates map.
        priority: locale.code === defaultLocale ? page.priority : Math.max(0.1, page.priority - 0.1),
        alternates: { languages: alternates },
      });
    }
  }

  return entries;
}
