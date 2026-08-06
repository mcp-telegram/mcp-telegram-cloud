import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../../legal.module.css";

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "privacyPage" });
  const canonical = canonicalForLocale(locale, "/privacy");
  const title = `${t("title")} — ${config.brandName}`;
  const description = t("metaDescription", { brand: config.brandName });
  return {
    title,
    description,
    alternates: { canonical, languages: languageAlternates("/privacy") },
    openGraph: { url: canonical, title, description },
    twitter: { title, description },
  };
}

export default async function PrivacyPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "privacyPage" });

  const hostLabel = config.issuer.replace(/^https?:\/\//, "");
  const repoLabel = config.sourceRepoUrl.replace(/^https?:\/\//, "");

  // Shared rich-text element factories. next-intl `t.rich` injects these into
  // translated strings, so the markup stays in code (one source of truth) while
  // the prose is localized. Each link/emphasis tag wraps the matching token.
  const link = (href: string) => (chunks: ReactNode) => (
    <a className={s.link} href={href}>
      {chunks}
    </a>
  );
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;
  const em = (chunks: ReactNode) => <em>{chunks}</em>;

  // List items are arrays of {term, desc} — translated via indexed keys to keep
  // the JSON flat and reviewable. We render a fixed count per section. The key
  // casts mirror the project pattern (see FeatureGuide.tsx) — next-intl types
  // keys as literals, so a dynamically-built key needs a representative cast.
  const li = (ns: string, count: number) =>
    Array.from({ length: count }, (_, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, never reordered — namespace+index is a stable key.
      <li key={`${ns}.${i}`}>
        <strong>{t(`${ns}.${i}.term` as "collect.items.0.term")}</strong> —{" "}
        {t.rich(`${ns}.${i}.desc` as "collect.items.0.desc", { strong, em })}
      </li>
    ));

  return (
    <>
      <SiteHeader />

      <div className={s.container}>
        <h1 className={s.h1}>{t("title")}</h1>
        <p className={s.updated}>{t("lastUpdated", { date: t("updatedDate") })}</p>

        <h2 className={s.h2}>{t("overview.heading")}</h2>
        <p className={s.p}>
          {t.rich("overview.body", {
            brand: config.brandName,
            host: link(config.issuer),
            hostLabel,
            strong,
          })}
        </p>

        <h2 className={s.h2}>{t("collect.heading")}</h2>
        <ul className={s.ul}>{li("collect.items", 3)}</ul>

        <h2 className={s.h2}>{t("analytics.heading")}</h2>
        <p className={s.p}>
          {t.rich("analytics.body", {
            metrikaHref: link("https://yandex.com/legal/confidential/"),
            gaHref: link("https://policies.google.com/privacy"),
            strong,
          })}
        </p>
        <ul className={s.ul}>{li("analytics.items", 3)}</ul>

        <h2 className={s.h2}>{t("notCollect.heading")}</h2>
        <ul className={s.ul}>
          <li>{t("notCollect.items.0")}</li>
          <li>{t("notCollect.items.1")}</li>
          <li>{t("notCollect.items.2")}</li>
        </ul>
        <p className={s.p}>{t.rich("notCollect.twoFactorNote", { strong })}</p>

        <h2 className={s.h2}>{t("dataFlow.heading")}</h2>
        <p className={s.p}>{t.rich("dataFlow.body", { strong })}</p>

        <h2 className={s.h2}>{t("retention.heading")}</h2>
        <ul className={s.ul}>{li("retention.items", 3)}</ul>

        <h2 className={s.h2}>{t("thirdParties.heading")}</h2>
        <p className={s.p}>{t.rich("thirdParties.body", { strong })}</p>

        <h2 className={s.h2}>{t("security.heading")}</h2>
        <p className={s.p}>{t("security.body")}</p>

        <h2 className={s.h2}>{t("rights.heading")}</h2>
        <ul className={s.ul}>
          <li>
            <strong>{t("rights.items.0.term")}</strong> — {t("rights.items.0.desc")}
          </li>
          <li>
            <strong>{t("rights.items.1.term")}</strong> — {t("rights.items.1.desc")}
          </li>
          <li>
            <strong>{t("rights.items.2.term")}</strong> —{" "}
            {t.rich("rights.items.2.desc", { repo: link(config.sourceRepoUrl) })}
          </li>
        </ul>

        <h2 className={s.h2}>{t("openSource.heading")}</h2>
        <p className={s.p}>{t.rich("openSource.body", { repo: link(config.sourceRepoUrl), repoLabel })}</p>

        <h2 className={s.h2}>{t("contact.heading")}</h2>
        <p className={s.p}>
          {t.rich("contact.body", { issues: link(config.issuesUrl), issuesLabel: config.issuesLabel })}
          {config.contactTelegram && (
            <>
              {" "}
              {t.rich("contact.telegram", {
                tg: link(`https://t.me/${config.contactTelegram}`),
                handle: config.contactTelegram,
              })}
            </>
          )}
          {config.contactEmail && (
            <>
              {" "}
              {t.rich("contact.email", {
                mail: link(`mailto:${config.contactEmail}`),
                address: config.contactEmail,
              })}
            </>
          )}
        </p>
      </div>

      <SiteFooter />
    </>
  );
}
