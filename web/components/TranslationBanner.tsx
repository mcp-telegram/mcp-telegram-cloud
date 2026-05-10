/** Banner shown on Tier 3 (UI-only translation) and on locales that fell
 * back to EN content because their messages file doesn't yet exist or is
 * out of date. */

import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, getLocale } from "@/lib/locales";

const HELP_TRANSLATE_URL = "https://github.com/mcp-telegram/mcp-telegram-cloud/blob/main/web/messages";

export function TranslationBanner() {
  const t = useTranslations("common");
  const tLang = useTranslations("language");
  const currentLocaleCode = useLocale();
  const meta = getLocale(currentLocaleCode);

  // No banner for the source locale (en) or for hand-curated Tier 1 locales.
  if (currentLocaleCode === defaultLocale) return null;
  if (meta && meta.tier === 1) return null;

  const labelKey = meta?.tier === 3 ? "fallbackToEnglish" : "machineTranslated";

  return (
    <div
      style={{
        padding: "10px 16px",
        background: "rgba(42, 171, 238, 0.1)",
        borderBottom: "1px solid rgba(42, 171, 238, 0.2)",
        textAlign: "center",
        fontSize: 13,
        color: "#bfd9ec",
      }}
    >
      <span>{t(labelKey)}</span>{" "}
      <a
        href={HELP_TRANSLATE_URL}
        style={{ color: "#2aabee", textDecoration: "underline" }}
        target="_blank"
        rel="noreferrer noopener"
      >
        {tLang("helpTranslate")}
      </a>
    </div>
  );
}
