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
import { config, iconUrl } from "@/lib/config";
import { getLocale } from "@/lib/locales";
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

  // Tier 3 locales fall back to English content at runtime — tell crawlers
  // not to index those URLs so we don't pollute search with EN-content pages
  // claiming to be Swahili/Persian/etc.
  const noindex = localeMeta?.tier === 3;

  return {
    metadataBase: new URL(config.issuer),
    title: { default: config.brandName, template: `%s — ${config.brandName}` },
    description: t("siteDescription"),
    icons: { icon: "/icon.svg" },
    openGraph: {
      type: "website",
      siteName: config.brandName,
      images: [{ url: iconUrl }],
    },
    twitter: { card: "summary", images: [iconUrl] },
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
