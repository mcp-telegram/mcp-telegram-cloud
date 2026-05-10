/** Compile-time validation of every t("key") call.
 *
 * `IntlMessages` is derived from `messages/en.json` (source of truth). Any
 * typo in `useTranslations("scope")` / `t("key")` becomes a TypeScript error,
 * and `bun run web:typecheck` catches missing keys before they ship. Other
 * locales should mirror the same shape — `validate-translations.ts` (Phase 5)
 * fails CI if a locale file is missing keys present in en.json. */

import type messages from "./messages/en.json";

declare global {
  interface IntlMessages extends Messages {}
}

type Messages = typeof messages;
