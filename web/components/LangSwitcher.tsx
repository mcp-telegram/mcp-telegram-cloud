"use client";

/** Header language switcher. Lists hand-curated and machine-reviewed locales
 * (Tier 1 + Tier 2) sorted by native name. Tier 3 locales are not shown
 * (still reachable via direct URL or Accept-Language). */

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { switchableLocales } from "@/lib/locales";

const sortedLocales = [...switchableLocales].sort((a, b) =>
  a.nameNative.localeCompare(b.nameNative, undefined, { sensitivity: "base" }),
);

export function LangSwitcher() {
  const t = useTranslations("language");
  const router = useRouter();
  const pathname = usePathname();
  const currentLocale = useLocale();

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
        {sortedLocales.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nameNative}
          </option>
        ))}
      </select>
    </label>
  );
}
