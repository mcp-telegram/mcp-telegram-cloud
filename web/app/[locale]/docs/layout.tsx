/** Sub-layout for /docs/* pages — adds a minimal header with logo + back-home
 * link + LangSwitcher. Keeps individual doc pages clean of nav chrome. */

import type { ReactNode } from "react";
import { LangSwitcher } from "@/components/LangSwitcher";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import s from "./header.module.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className={s.header}>
        <Link href="/" className={s.brand}>
          {/* biome-ignore lint/performance/noImgElement: served from Hono backend, not next/image-optimised. */}
          <img src="/icon.svg" alt="" width={24} height={24} />
          {config.brandName}
        </Link>
        <LangSwitcher />
      </header>
      {children}
    </>
  );
}
