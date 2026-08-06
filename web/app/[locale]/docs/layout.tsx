/** Sub-layout for /docs/* pages.
 *
 * The redesign gives every page the same chrome, so this renders the shared
 * SiteHeader/SiteFooter instead of the minimal doc-only header it used before. */

import type { ReactNode } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
