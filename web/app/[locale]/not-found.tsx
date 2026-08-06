/** Localised 404.
 *
 * Lives under [locale] so it renders inside the locale layout and can read
 * messages; the proxy routes unmatched paths through that segment. The root
 * app/not-found.tsx covers the few requests that never reach it (see there).
 *
 * The paper plane that carries the brand flew off with the page — the mini
 * chat replays the product's own idiom (prompt → tool call → reply) as the
 * joke, using the same cascade timings as the hero demo. */

import { useTranslations } from "next-intl";
import { TbSend } from "react-icons/tb";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { Link } from "@/i18n/navigation";
import s from "../not-found.module.css";

export default function NotFound() {
  const t = useTranslations("notFound");
  const tNav = useTranslations("nav");

  // The tab title stays the layout's brand default: not-found.tsx cannot
  // export generateMetadata, and a hoisted inline <title> only applies on the
  // client, so it would leave SSR and hydration disagreeing. Next.js already
  // emits `noindex` plus a 404 status here, which is what crawlers act on.

  return (
    <>
      <SiteHeader />

      <main className={s.container}>
        <div className={s.digits} aria-hidden>
          <span className={`${s.digit} ${s.digitLeft}`}>4</span>
          <span className={s.plane}>
            <TbSend size="55%" />
          </span>
          <span className={`${s.digit} ${s.digitRight}`}>4</span>
        </div>

        {/* Decorative restaging of the hero demo — the heading below carries
         * the actual message, so screen readers skip the skit. */}
        <div className={s.chat} aria-hidden>
          <div className={s.bubbleOut}>{t("ask")}</div>
          <div className={s.toolChip}>
            <span className={s.toolDots}>
              <i />
              <i />
              <i />
            </span>
            telegram-find-page
          </div>
          <div className={s.bubbleIn}>{t("reply")} 🤷</div>
        </div>

        <h1 className={s.title}>{t("title")}</h1>
        <p className={s.desc}>{t("desc")}</p>

        <div className={s.actions}>
          <Link href="/" className={s.primary}>
            {t("home")}
          </Link>
          <Link href="/docs/quickstart" className={s.secondary}>
            {tNav("quickstart")}
          </Link>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
