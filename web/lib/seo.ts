/** SEO helpers for hreflang + canonical generation across locales.
 *
 * URL strategy with `localePrefix: 'as-needed'`:
 *   - default locale (en):   `${issuer}/path`
 *   - other locales (ru, …): `${issuer}/<locale>/path`
 *
 * `languageAlternates` returns the full `{ <hreflang>: <url> }` map for the
 * Metadata API + an `x-default` pointing at the EN URL — this is the Google
 * canonical recommendation for international sites. */

import { config } from "./config";
import { defaultLocale, indexableLocales } from "./locales";

function joinPath(path: string): string {
  if (path === "/" || path === "") return "";
  return path.startsWith("/") ? path : `/${path}`;
}

/** Build the canonical URL for a given locale + path (path begins with "/"). */
export function canonicalForLocale(locale: string, path: string): string {
  const suffix = joinPath(path);
  const localePart = locale === defaultLocale ? "" : `/${locale}`;
  return `${config.issuer}${localePart}${suffix}`;
}

/** Map of `{ hreflang -> URL }` for every locale we index (Tier 1 + Tier 2).
 *
 * Tier 3 locales are deliberately excluded — they serve EN content at
 * runtime, so emitting them as hreflang alternates would mislead crawlers
 * and risk being treated as duplicate or low-quality pages. They remain
 * reachable via direct URL but are not advertised.
 *
 * Uses `hreflang` from locale meta (handles zh-CN → zh-Hans mapping).
 * Includes `x-default` pointing at the EN URL. */
export function languageAlternates(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of indexableLocales) {
    out[l.hreflang] = canonicalForLocale(l.code, path);
  }
  out["x-default"] = canonicalForLocale(defaultLocale, path);
  return out;
}
