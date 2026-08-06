"use client";

/** Header light/dark toggle.
 *
 * The stored choice is an explicit override of `prefers-color-scheme`; the
 * blocking script in ThemeScript applies it before paint. Until mount we don't
 * know the resolved theme (the server can't read localStorage or the OS), so
 * the button renders a stable placeholder icon and announces itself generically
 * — flipping the icon after hydration would otherwise cause a mismatch. */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { TbMoon, TbSun } from "react-icons/tb";
import { THEME_STORAGE_KEY } from "./ThemeScript";

type Theme = "light" | "dark";

function resolveTheme(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle({ className }: { className: string | undefined }) {
  const t = useTranslations("nav");
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(resolveTheme());
  }, []);

  function toggle() {
    const next: Theme = (theme ?? resolveTheme()) === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private mode / storage disabled — the theme still applies for this page.
    }
    setTheme(next);
  }

  return (
    <button type="button" onClick={toggle} className={className} aria-label={t("toggleTheme")} title={t("toggleTheme")}>
      {theme === "dark" ? <TbSun size={18} aria-hidden /> : <TbMoon size={18} aria-hidden />}
    </button>
  );
}
