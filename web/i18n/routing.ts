/** next-intl routing config — single source of truth for locale prefix and
 * supported locales. Imported by the request config, the proxy, and the
 * navigation helpers. */

import { defineRouting } from "next-intl/routing";
import { defaultLocale, localeCodes } from "@/lib/locales";

export const routing = defineRouting({
  locales: localeCodes,
  defaultLocale,
  // 'as-needed': default locale (en) served at `/`, others at `/<locale>/`.
  // Keeps the existing /, /privacy, /terms URLs stable for SEO while opening
  // /ru/, /ja/, … for translated content.
  localePrefix: "as-needed",
});
