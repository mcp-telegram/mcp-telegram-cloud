import type { MetadataRoute } from "next";
import { defaultLocale, locales } from "@/lib/locales";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";

/** Sitemap with hreflang alternates for every locale × every page.
 *
 * Pages currently shipped: /, /privacy, /terms.
 * Phase 3-4 add: /docs/quickstart{,/claude,/chatgpt}, /examples.
 *
 * Output is ~70 locales × ~3 paths = ~210 entries. Default locale (en) is at
 * the un-prefixed URL (`/`), other locales at `/<locale>/...`. */

const PAGES: { path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }[] = [
  { path: "/", changeFrequency: "monthly", priority: 1 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const page of PAGES) {
    const alternates = languageAlternates(page.path);
    for (const locale of locales) {
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
