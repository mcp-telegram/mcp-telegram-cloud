/** Server-only analytics config for the content site.
 *
 * Mirrors the `config.ts` pattern: reads process.env at render time inside RSC
 * (safe — these pages render on the server). The resolved IDs are passed down
 * to the client `<Analytics>` loader as props, so no secret is shipped that
 * isn't already a public tracking ID.
 *
 * Both IDs default to empty. When empty, the corresponding tracker is never
 * loaded — this keeps the OSS repo clean (self-hosters get zero tracking unless
 * they set their own IDs) and lets us ship the code before flipping it on in
 * production via env.
 *
 * Verification (Yandex Webmaster, Google Search Console) is handled out-of-band
 * via DNS TXT records, so there are no verification meta tags here. */

const trimmed = (value: string | undefined): string => value?.trim() || "";

/** Yandex.Metrika counter ID (numeric string, e.g. "109575851"). Empty = off. */
const metrikaId = trimmed(process.env.METRIKA_ID);

/** GA4 Measurement ID (e.g. "G-XXXXXXXXXX"). Empty = off. */
const ga4Id = trimmed(process.env.GA4_ID);

export const analytics = {
  metrikaId,
  ga4Id,
  /** True when at least one tracker is configured — gates the consent banner.
   * No trackers configured → no banner, no client analytics bundle. */
  enabled: Boolean(metrikaId || ga4Id),
} as const;
