"use client";

/** Shared site header: logo, primary nav, language switcher, theme toggle.
 *
 * Client-side because of the burger menu state. The breakpoint itself is a
 * media query in CSS (not a JS resize listener), so the server renders the same
 * markup for every viewport and nothing shifts on hydration.
 *
 * Section anchors (#features, #faq) only exist on the landing page, so they are
 * rendered as locale-aware links to `/` plus the fragment rather than bare
 * hrefs — clicking "FAQ" from /examples then lands in the right place. */

import { useTranslations } from "next-intl";
import { useState } from "react";
import { TbMenu2, TbX } from "react-icons/tb";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { LangSwitcher } from "./LangSwitcher";
import s from "./SiteHeader.module.css";
import { ThemeToggle } from "./ThemeToggle";

type NavItem = { href: string; label: string; external?: boolean };

export function SiteHeader() {
  const t = useTranslations("nav");
  const [menuOpen, setMenuOpen] = useState(false);

  const items: NavItem[] = [
    { href: "/#features", label: t("features") },
    { href: "/docs/quickstart", label: t("quickstart") },
    { href: "/examples", label: t("examples") },
    { href: "/#faq", label: t("faq") },
    { href: config.sourceRepoUrl, label: t("github"), external: true },
  ];

  // CSS-module lookups widen to `string | undefined` under
  // noUncheckedIndexedAccess, so the class param accepts that shape directly.
  function renderLink(item: NavItem, className: string | undefined) {
    if (item.external) {
      return (
        <a key={item.href} href={item.href} className={className} onClick={() => setMenuOpen(false)}>
          {item.label}
        </a>
      );
    }
    return (
      <Link key={item.href} href={item.href} className={className} onClick={() => setMenuOpen(false)}>
        {item.label}
      </Link>
    );
  }

  return (
    <header className={s.header}>
      <div className={s.inner}>
        <Link href="/" className={s.logo}>
          {/* biome-ignore lint/performance/noImgElement: served from the Hono backend, not next/image-optimised. */}
          <img src="/icon.svg" alt="" width={30} height={30} />
          {config.brandName}
        </Link>

        <div className={s.controls}>
          <nav className={s.nav}>{items.map((item) => renderLink(item, s.navLink))}</nav>
          <LangSwitcher />
          <ThemeToggle className={s.iconButton} />
          <button
            type="button"
            className={`${s.iconButton} ${s.burger}`}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? t("closeMenu") : t("openMenu")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <TbX size={18} aria-hidden /> : <TbMenu2 size={18} aria-hidden />}
          </button>
        </div>
      </div>

      {menuOpen && <nav className={s.mobileMenu}>{items.map((item) => renderLink(item, s.mobileLink))}</nav>}
    </header>
  );
}
