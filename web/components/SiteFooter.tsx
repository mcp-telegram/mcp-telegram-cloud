/** Shared site footer. Server component — no interactive state. */

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import s from "./SiteFooter.module.css";

export function SiteFooter() {
  const t = useTranslations("footer");
  const tNav = useTranslations("nav");

  return (
    <footer className={s.footer}>
      <div className={s.links}>
        <a href={config.sourceRepoUrl}>{tNav("github")}</a>
        <span>{t("mit")}</span>
        <a href={config.issuesUrl}>{config.issuesLabel}</a>
        <Link href="/privacy">{t("privacy")}</Link>
        <Link href="/terms">{t("terms")}</Link>
      </div>
      <p className={s.copy}>
        &copy; {new Date().getFullYear()} {config.brandName}. {t("tagline")}
      </p>
    </footer>
  );
}
