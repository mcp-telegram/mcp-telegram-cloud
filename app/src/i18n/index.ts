import { DEFAULT_LOCALE, LOCALE_CODES } from "./locales.js";
import { ar } from "./messages/ar.js";
import { de } from "./messages/de.js";
import { en } from "./messages/en.js";
import { es } from "./messages/es.js";
import { fr } from "./messages/fr.js";
import { hi } from "./messages/hi.js";
import { id } from "./messages/id.js";
import { it } from "./messages/it.js";
import { ja } from "./messages/ja.js";
import { ko } from "./messages/ko.js";
import { nl } from "./messages/nl.js";
import { pl } from "./messages/pl.js";
import { ptBR } from "./messages/pt-BR.js";
import { ru } from "./messages/ru.js";
import { th } from "./messages/th.js";
import { tr } from "./messages/tr.js";
import { uk } from "./messages/uk.js";
import { vi } from "./messages/vi.js";
import { zhCN } from "./messages/zh-CN.js";
import { zhTW } from "./messages/zh-TW.js";
import type { MessageKey, Messages } from "./types.js";

export { DEFAULT_LOCALE, isRtl, LOCALE_CODES, LOCALES, type LocaleMeta } from "./locales.js";
export type { MessageKey, Messages } from "./types.js";

/**
 * Catalog registry. Locales without a hand/machine catalog yet fall back to
 * English at lookup time (see `getMessages`). As `./messages/<code>.ts` files
 * land, register them here — the `Messages` type guarantees they're complete.
 */
const CATALOGS: Partial<Record<string, Messages>> = {
  en,
  ru,
  es,
  de,
  fr,
  "pt-BR": ptBR,
  it,
  pl,
  tr,
  nl,
  uk,
  ja,
  ko,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ar,
  hi,
  id,
  vi,
  th,
};

export function getMessages(locale: string): Messages {
  return CATALOGS[locale] ?? en;
}

/** Translator bound to a resolved catalog. `t("login.title")` is type-checked. */
export type Translate = (key: MessageKey) => string;

export function createTranslator(messages: Messages): Translate {
  return (key: MessageKey): string => {
    const dot = key.indexOf(".");
    const section = key.slice(0, dot) as keyof Messages;
    const leaf = key.slice(dot + 1);
    // Both casts are sound: MessageKey is constructed from exactly these
    // section/leaf pairs, so the lookup always hits a string.
    return (messages[section] as Record<string, string>)[leaf] ?? key;
  };
}

/**
 * Resolve the best locale for a request. Precedence:
 *   1. explicit cookie (user's manual switcher choice) if supported,
 *   2. the first `Accept-Language` entry whose base language we support,
 *   3. DEFAULT_LOCALE.
 *
 * Matching is case-insensitive and falls back from a regional tag to its base
 * language (e.g. `pt-PT` → `pt-BR` is NOT auto-matched, but `de-AT` → `de` is),
 * mirroring how the marketing site negotiates.
 */
export function detectLocale(acceptLanguage: string | undefined, cookieLocale: string | undefined): string {
  if (cookieLocale && LOCALE_CODES.includes(cookieLocale)) return cookieLocale;

  if (acceptLanguage) {
    const requested = acceptLanguage
      .split(",")
      .map((part) => {
        const [tag, q] = part.trim().split(";q=");
        return { tag: (tag ?? "").toLowerCase(), q: q ? Number.parseFloat(q) : 1 };
      })
      .filter((e) => e.tag)
      .sort((a, b) => b.q - a.q);

    const lowerCodes = new Map(LOCALE_CODES.map((c) => [c.toLowerCase(), c]));
    for (const { tag } of requested) {
      const exact = lowerCodes.get(tag);
      if (exact) return exact;
      // Base-language fallback: `de-at` → `de` if `de` is supported.
      const base = tag.split("-")[0];
      const baseMatch = base ? lowerCodes.get(base) : undefined;
      if (baseMatch) return baseMatch;
    }
  }

  return DEFAULT_LOCALE;
}
