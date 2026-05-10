/** next-intl request config — runs per-request on the server, supplies
 * locale + messages to RSC and `getTranslations()` callers.
 *
 * Locales without their own translated `messages/<locale>.json` fall back to
 * EN at runtime. Phase 5 (machine translation) populates Tier 2/3 files; the
 * fallback keeps the build green during the rollout. */

import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

async function loadMessages(locale: string): Promise<IntlMessages> {
  try {
    return (await import(`../messages/${locale}.json`)).default;
  } catch {
    return (await import(`../messages/${routing.defaultLocale}.json`)).default;
  }
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return { locale, messages: await loadMessages(locale) };
});
