/** Catch-all for unmatched paths under a locale.
 *
 * Without this, a URL that matches no route never enters the [locale] segment,
 * so app/[locale]/not-found.tsx is never reached and Next.js falls back to its
 * built-in 404. Calling notFound() from here hands rendering to our own page
 * (chrome, theme and translations included).
 *
 * Preferred over the experimental `globalNotFound` flag: same result, stable
 * API, and the 404 still renders inside the locale layout. */

import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

type Props = { params: Promise<{ locale: string }> };

export default async function CatchAllNotFound({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  notFound();
}
