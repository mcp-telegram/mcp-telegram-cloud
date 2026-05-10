/** Compile-time validation of every t("key") call.
 *
 * Augments `next-intl`'s `AppConfig` with our concrete message shape derived
 * from `messages/en.json` (source of truth). Any typo in
 * `useTranslations("scope")` or `t("key")` becomes a TypeScript error, and
 * `bun run web:typecheck` catches it before they ship. Other locales should
 * mirror the same shape — `validate-translations.ts` (Phase 5) fails CI if a
 * locale file is missing keys present in en.json. */

import type { routing } from "./i18n/routing";
import type messages from "./messages/en.json";

declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof messages;
  }
}
