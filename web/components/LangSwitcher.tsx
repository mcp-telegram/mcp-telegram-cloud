"use client";

/** Header language switcher. Lists Tier 1 + Tier 2 locales sorted by native
 * name. If the current page is a Tier 3 locale (reached via direct URL or
 * Accept-Language) the active locale is appended so the `<select>` never
 * renders an unmatched value. */

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { getLocale, switchableLocales } from "@/lib/locales";

const sortedSwitchable = [...switchableLocales].sort((a, b) =>
  a.nameNative.localeCompare(b.nameNative, undefined, { sensitivity: "base" }),
);

export function LangSwitcher() {
  const t = useTranslations("language");
  const router = useRouter();
  const pathname = usePathname();
  const currentLocale = useLocale();

  // If we're on a Tier 3 locale, ensure the switcher includes it so the
  // controlled <select> can render the matching <option>.
  const inSwitchable = sortedSwitchable.some((l) => l.code === currentLocale);
  const activeMeta = inSwitchable ? null : getLocale(currentLocale);
  const options = inSwitchable || !activeMeta ? sortedSwitchable : [activeMeta, ...sortedSwitchable];

  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
        opacity: 0.85,
      }}
    >
      <span className="visually-hidden" style={{ position: "absolute", left: "-9999px" }}>
        {t("switcherLabel")}
      </span>
      <select
        value={currentLocale}
        onChange={(e) => router.replace(pathname, { locale: e.target.value })}
        style={{
          background: "transparent",
          color: "inherit",
          border: "1px solid currentColor",
          borderRadius: 6,
          padding: "4px 8px",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        {options.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nameNative}
          </option>
        ))}
      </select>
    </label>
  );
}
