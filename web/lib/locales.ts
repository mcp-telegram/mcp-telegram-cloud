/** Telegram-supported locales for mcp-telegram.com.
 *
 * Source of truth: claudedocs/telegram-locales-snapshot.md (snapshot 2026-05-10
 * from translations.telegram.org). Refresh process documented there.
 *
 * Tier classification:
 * - Tier 1: hand-curated content (en, ru — full MDX, full UI strings).
 * - Tier 2: machine-translated content + community review hook (UI + content).
 * - Tier 3: machine-translated UI strings only; content pages fall back to EN
 *   with a "Help translate" banner.
 *
 * Locale codes follow Telegram's conventions (zh-CN, zh-TW, pt-BR, pt-PT). For
 * SEO, hreflang emits zh-Hans/zh-Hant per Google's recommendation — see
 * `app/[locale]/layout.tsx` Metadata API. */

export type LocaleTier = 1 | 2 | 3;

export type Locale = {
  /** Locale code as used in URL paths (e.g. `en`, `ru`, `zh-CN`). */
  code: string;
  /** English display name. */
  name: string;
  /** Native display name (used in language switcher). */
  nameNative: string;
  /** Right-to-left script flag — drives `<html dir>`. */
  rtl: boolean;
  tier: LocaleTier;
  /** BCP-47 hreflang code, may differ from URL code (zh-CN → zh-Hans). */
  hreflang: string;
};

export const locales: readonly Locale[] = [
  { code: "en", name: "English", nameNative: "English", rtl: false, tier: 1, hreflang: "en" },
  { code: "ru", name: "Russian", nameNative: "Русский", rtl: false, tier: 1, hreflang: "ru" },

  { code: "es", name: "Spanish", nameNative: "Español", rtl: false, tier: 2, hreflang: "es" },
  { code: "de", name: "German", nameNative: "Deutsch", rtl: false, tier: 2, hreflang: "de" },
  { code: "fr", name: "French", nameNative: "Français", rtl: false, tier: 2, hreflang: "fr" },
  {
    code: "pt-BR",
    name: "Portuguese (Brazil)",
    nameNative: "Português (Brasil)",
    rtl: false,
    tier: 2,
    hreflang: "pt-BR",
  },
  { code: "it", name: "Italian", nameNative: "Italiano", rtl: false, tier: 2, hreflang: "it" },
  { code: "pl", name: "Polish", nameNative: "Polski", rtl: false, tier: 2, hreflang: "pl" },
  { code: "tr", name: "Turkish", nameNative: "Türkçe", rtl: false, tier: 2, hreflang: "tr" },
  { code: "nl", name: "Dutch", nameNative: "Nederlands", rtl: false, tier: 2, hreflang: "nl" },
  { code: "uk", name: "Ukrainian", nameNative: "Українська", rtl: false, tier: 2, hreflang: "uk" },
  { code: "ja", name: "Japanese", nameNative: "日本語", rtl: false, tier: 2, hreflang: "ja" },
  { code: "ko", name: "Korean", nameNative: "한국어", rtl: false, tier: 2, hreflang: "ko" },
  { code: "zh-CN", name: "Chinese (Simplified)", nameNative: "简体中文", rtl: false, tier: 2, hreflang: "zh-Hans" },
  { code: "zh-TW", name: "Chinese (Traditional)", nameNative: "繁體中文", rtl: false, tier: 2, hreflang: "zh-Hant" },
  { code: "ar", name: "Arabic", nameNative: "العربية", rtl: true, tier: 2, hreflang: "ar" },
  { code: "hi", name: "Hindi", nameNative: "हिन्दी", rtl: false, tier: 2, hreflang: "hi" },
  { code: "id", name: "Indonesian", nameNative: "Bahasa Indonesia", rtl: false, tier: 2, hreflang: "id" },
  { code: "vi", name: "Vietnamese", nameNative: "Tiếng Việt", rtl: false, tier: 2, hreflang: "vi" },
  { code: "th", name: "Thai", nameNative: "ไทย", rtl: false, tier: 2, hreflang: "th" },

  { code: "af", name: "Afrikaans", nameNative: "Afrikaans", rtl: false, tier: 3, hreflang: "af" },
  { code: "sq", name: "Albanian", nameNative: "Shqip", rtl: false, tier: 3, hreflang: "sq" },
  { code: "am", name: "Amharic", nameNative: "አማርኛ", rtl: false, tier: 3, hreflang: "am" },
  { code: "hy", name: "Armenian", nameNative: "Հայերեն", rtl: false, tier: 3, hreflang: "hy" },
  { code: "az", name: "Azerbaijani", nameNative: "Azərbaycanca", rtl: false, tier: 3, hreflang: "az" },
  { code: "eu", name: "Basque", nameNative: "Euskara", rtl: false, tier: 3, hreflang: "eu" },
  { code: "be", name: "Belarusian", nameNative: "Беларуская", rtl: false, tier: 3, hreflang: "be" },
  { code: "bn", name: "Bengali", nameNative: "বাংলা", rtl: false, tier: 3, hreflang: "bn" },
  { code: "bg", name: "Bulgarian", nameNative: "Български", rtl: false, tier: 3, hreflang: "bg" },
  { code: "my", name: "Burmese", nameNative: "မြန်မာဘာသာ", rtl: false, tier: 3, hreflang: "my" },
  { code: "ca", name: "Catalan", nameNative: "Català", rtl: false, tier: 3, hreflang: "ca" },
  { code: "hr", name: "Croatian", nameNative: "Hrvatski", rtl: false, tier: 3, hreflang: "hr" },
  { code: "cs", name: "Czech", nameNative: "Čeština", rtl: false, tier: 3, hreflang: "cs" },
  { code: "da", name: "Danish", nameNative: "Dansk", rtl: false, tier: 3, hreflang: "da" },
  { code: "eo", name: "Esperanto", nameNative: "Esperanto", rtl: false, tier: 3, hreflang: "eo" },
  { code: "et", name: "Estonian", nameNative: "Eesti", rtl: false, tier: 3, hreflang: "et" },
  { code: "fil", name: "Filipino", nameNative: "Filipino", rtl: false, tier: 3, hreflang: "fil" },
  { code: "fi", name: "Finnish", nameNative: "Suomi", rtl: false, tier: 3, hreflang: "fi" },
  { code: "gl", name: "Galician", nameNative: "Galego", rtl: false, tier: 3, hreflang: "gl" },
  { code: "ka", name: "Georgian", nameNative: "ქართული", rtl: false, tier: 3, hreflang: "ka" },
  { code: "el", name: "Greek", nameNative: "Ελληνικά", rtl: false, tier: 3, hreflang: "el" },
  { code: "gu", name: "Gujarati", nameNative: "ગુજરાતી", rtl: false, tier: 3, hreflang: "gu" },
  { code: "he", name: "Hebrew", nameNative: "עברית", rtl: true, tier: 3, hreflang: "he" },
  { code: "hu", name: "Hungarian", nameNative: "Magyar", rtl: false, tier: 3, hreflang: "hu" },
  { code: "ga", name: "Irish", nameNative: "Gaeilge", rtl: false, tier: 3, hreflang: "ga" },
  { code: "kn", name: "Kannada", nameNative: "ಕನ್ನಡ", rtl: false, tier: 3, hreflang: "kn" },
  { code: "kk", name: "Kazakh", nameNative: "Қазақша", rtl: false, tier: 3, hreflang: "kk" },
  { code: "km", name: "Khmer", nameNative: "ភាសាខ្មែរ", rtl: false, tier: 3, hreflang: "km" },
  { code: "lv", name: "Latvian", nameNative: "Latviešu", rtl: false, tier: 3, hreflang: "lv" },
  { code: "lt", name: "Lithuanian", nameNative: "Lietuvių", rtl: false, tier: 3, hreflang: "lt" },
  { code: "ms", name: "Malay", nameNative: "Melayu", rtl: false, tier: 3, hreflang: "ms" },
  { code: "ml", name: "Malayalam", nameNative: "മലയാളം", rtl: false, tier: 3, hreflang: "ml" },
  { code: "mt", name: "Maltese", nameNative: "Malti", rtl: false, tier: 3, hreflang: "mt" },
  { code: "mr", name: "Marathi", nameNative: "मराठी", rtl: false, tier: 3, hreflang: "mr" },
  { code: "ne", name: "Nepali", nameNative: "नेपाली", rtl: false, tier: 3, hreflang: "ne" },
  { code: "nb", name: "Norwegian (Bokmål)", nameNative: "Norsk bokmål", rtl: false, tier: 3, hreflang: "nb" },
  { code: "or", name: "Odia", nameNative: "ଓଡ଼ିଆ", rtl: false, tier: 3, hreflang: "or" },
  { code: "fa", name: "Persian", nameNative: "فارسی", rtl: true, tier: 3, hreflang: "fa" },
  {
    code: "pt-PT",
    name: "Portuguese (Portugal)",
    nameNative: "Português (Portugal)",
    rtl: false,
    tier: 3,
    hreflang: "pt-PT",
  },
  { code: "ro", name: "Romanian", nameNative: "Română", rtl: false, tier: 3, hreflang: "ro" },
  { code: "sr", name: "Serbian", nameNative: "Српски", rtl: false, tier: 3, hreflang: "sr" },
  { code: "sk", name: "Slovak", nameNative: "Slovenčina", rtl: false, tier: 3, hreflang: "sk" },
  { code: "sl", name: "Slovene", nameNative: "Slovenščina", rtl: false, tier: 3, hreflang: "sl" },
  { code: "sw", name: "Swahili", nameNative: "Kiswahili", rtl: false, tier: 3, hreflang: "sw" },
  { code: "sv", name: "Swedish", nameNative: "Svenska", rtl: false, tier: 3, hreflang: "sv" },
  { code: "tg", name: "Tajik", nameNative: "Тоҷикӣ", rtl: false, tier: 3, hreflang: "tg" },
  { code: "ta", name: "Tamil", nameNative: "தமிழ்", rtl: false, tier: 3, hreflang: "ta" },
  { code: "te", name: "Telugu", nameNative: "తెలుగు", rtl: false, tier: 3, hreflang: "te" },
  { code: "tk", name: "Turkmen", nameNative: "Türkmençe", rtl: false, tier: 3, hreflang: "tk" },
  { code: "ur", name: "Urdu", nameNative: "اردو", rtl: true, tier: 3, hreflang: "ur" },
  { code: "uz", name: "Uzbek", nameNative: "Oʻzbekcha", rtl: false, tier: 3, hreflang: "uz" },
] as const;

export const localeCodes = locales.map((l) => l.code) as readonly string[];
export const defaultLocale = "en" as const;

export const tier1Locales = locales.filter((l) => l.tier === 1).map((l) => l.code);
export const tier2Locales = locales.filter((l) => l.tier === 2).map((l) => l.code);
export const tier3Locales = locales.filter((l) => l.tier === 3).map((l) => l.code);

/** Locales we expose to search engines and language pickers.
 *
 * Tier 1 (en, ru) is hand-curated; Tier 2 (18 locales) is machine-translated
 * inline by Claude. Both have locale-specific content worth advertising as
 * separate language alternates.
 *
 * Tier 3 locales are intentionally NOT in this list because they fall back
 * to English content at runtime (see `i18n/request.ts`) and we don't want
 * Google to index `/sw/` or `/fa/` as Swahili/Persian when the body is
 * actually English — that's a clear SEO red flag and bad UX. Tier 3 stays
 * reachable via direct URL or Accept-Language detection. */
export const indexableLocales = locales.filter((l) => l.tier <= 2);

/** LangSwitcher shows the indexable set, plus the active locale even if it
 * is Tier 3 — keeps the `<select>` from rendering an unmatched value. */
export const switchableLocales = indexableLocales;

const localeByCode = new Map<string, Locale>(locales.map((l) => [l.code, l] as const));

export function getLocale(code: string): Locale | undefined {
  return localeByCode.get(code);
}

export function isKnownLocale(code: string): boolean {
  return localeByCode.has(code);
}
