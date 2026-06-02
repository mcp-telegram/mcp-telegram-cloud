/**
 * The 20 locales that have message catalogs for the backend pages — the same
 * tier-1/tier-2 set the marketing site (`web/`) ships translations for. The
 * canonical locale registry (native names, RTL, tier) lives in
 * `web/lib/locales.ts`; we mirror only the subset relevant here to avoid a
 * cross-workspace import at runtime (the app bundle must not pull in web code).
 *
 * Keep this list in lockstep with the catalogs in `./messages/` — a code here
 * without a catalog falls back to English (see `./index.ts` registry).
 */
export type LocaleMeta = {
  readonly code: string;
  readonly nameNative: string;
  readonly rtl: boolean;
};

export const LOCALES: readonly LocaleMeta[] = [
  { code: "en", nameNative: "English", rtl: false },
  { code: "ru", nameNative: "Русский", rtl: false },
  { code: "es", nameNative: "Español", rtl: false },
  { code: "de", nameNative: "Deutsch", rtl: false },
  { code: "fr", nameNative: "Français", rtl: false },
  { code: "pt-BR", nameNative: "Português (Brasil)", rtl: false },
  { code: "it", nameNative: "Italiano", rtl: false },
  { code: "pl", nameNative: "Polski", rtl: false },
  { code: "tr", nameNative: "Türkçe", rtl: false },
  { code: "nl", nameNative: "Nederlands", rtl: false },
  { code: "uk", nameNative: "Українська", rtl: false },
  { code: "ja", nameNative: "日本語", rtl: false },
  { code: "ko", nameNative: "한국어", rtl: false },
  { code: "zh-CN", nameNative: "简体中文", rtl: false },
  { code: "zh-TW", nameNative: "繁體中文", rtl: false },
  { code: "ar", nameNative: "العربية", rtl: true },
  { code: "hi", nameNative: "हिन्दी", rtl: false },
  { code: "id", nameNative: "Bahasa Indonesia", rtl: false },
  { code: "vi", nameNative: "Tiếng Việt", rtl: false },
  { code: "th", nameNative: "ไทย", rtl: false },
] as const;

export const DEFAULT_LOCALE = "en";

export const LOCALE_CODES: readonly string[] = LOCALES.map((l) => l.code);

export function isRtl(code: string): boolean {
  return LOCALES.find((l) => l.code === code)?.rtl ?? false;
}
