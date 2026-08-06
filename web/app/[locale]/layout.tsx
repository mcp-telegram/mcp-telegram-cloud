/** Root layout for the app — lives under [locale] because that segment owns
 * `<html lang dir>`. With `localePrefix: 'as-needed'` next-intl serves `/`
 * as locale=en (no prefix), `/ru/` as locale=ru, etc.
 *
 * Sibling route handlers (sitemap.ts, robots.ts, next-health) live at
 * `app/*` and do not require a layout, so deleting `app/layout.tsx` is fine. */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { Analytics } from "@/components/Analytics";
import { ConsentBanner } from "@/components/ConsentBanner";
import { ThemeScript } from "@/components/ThemeScript";
import { routing } from "@/i18n/routing";
import { analytics } from "@/lib/analytics";
import { config } from "@/lib/config";
import { getLocale } from "@/lib/locales";
import { canonicalForLocale } from "@/lib/seo";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: LayoutProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "metadata" });
  const localeMeta = getLocale(locale);

  // Rendered by app/[locale]/opengraph-image.tsx in this request's locale.
  // Built through canonicalForLocale so the default locale gets no prefix —
  // `/en/opengraph-image` would 307, and preview crawlers often don't follow
  // redirects, leaving the card blank.
  const ogImage = canonicalForLocale(locale, "/opengraph-image");

  // Tier 3 locales fall back to English content at runtime — tell crawlers
  // not to index those URLs so we don't pollute search with EN-content pages
  // claiming to be Swahili/Persian/etc.
  const noindex = localeMeta?.tier === 3;

  return {
    metadataBase: new URL(config.issuer),
    title: { default: config.brandName, template: `%s — ${config.brandName}` },
    description: t("siteDescription"),
    icons: { icon: "/icon.svg" },
    // The generated card is pointed at explicitly rather than left to the
    // opengraph-image.tsx convention: that convention only tags its own route
    // segment, so /docs/* and /examples would ship without a preview image.
    // The SVG icon is not used here — Telegram, Slack and X don't render SVG.
    openGraph: {
      type: "website",
      siteName: config.brandName,
      images: [{ url: ogImage, width: 1200, height: 630, alt: config.brandName }],
    },
    // summary_large_image is what turns the preview into a wide banner rather
    // than a thumbnail beside the text.
    twitter: { card: "summary_large_image", images: [ogImage] },
    robots: noindex ? { index: false, follow: true } : undefined,
  };
}

export default async function LocaleLayout({ children, params }: LayoutProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Enable static rendering — must be called before any next-intl hook.
  setRequestLocale(locale);

  const localeMeta = getLocale(locale);
  const dir = localeMeta?.rtl ? "rtl" : "ltr";

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <NextIntlClientProvider locale={locale}>
          {children}
          {analytics.enabled && (
            <>
              <ConsentBanner />
              <Analytics metrikaId={analytics.metrikaId} ga4Id={analytics.ga4Id} />
            </>
          )}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
