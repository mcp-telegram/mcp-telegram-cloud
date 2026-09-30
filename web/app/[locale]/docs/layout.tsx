/** Sub-layout for /docs/* pages.
 *
 * The redesign gives every page the same chrome, so this renders the shared
 * SiteHeader/SiteFooter instead of the minimal doc-only header it used before.
 *
 * `setRequestLocale` is required here, not only in the pages: a layout renders
 * independently of its page, and without it next-intl resolves the locale from
 * request headers, which turned every /docs page into a per-request render. */

import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default async function DocsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
