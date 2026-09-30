/** Why a user-authorized Telegram client is a legitimate way to reach Telegram
 * (mcp-telegram-cloud#32).
 *
 * Written for two audiences at once: users asking "is this allowed?", and app
 * directory reviewers (Anthropic, OpenAI) whose policies ask about third-party
 * APIs the developer does not control. Every claim here must stay true in the
 * code: the 20/day limit is `DESTRUCTIVE_DAILY_LIMIT` in src/config.ts, the
 * confirmation step lives in skills/telegram-reply/SKILL.md, the labels are the
 * tool annotations. Change the page when any of those change. */

import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates, socialMetadata, socialTitle } from "@/lib/seo";
import s from "../../../legal.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const PATH = "/docs/access-model";
const TELEGRAM_API_URL = "https://core.telegram.org/api/obtaining_api_id";
const TELEGRAM_TERMS_URL = "https://core.telegram.org/api/terms";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "accessModel" });
  const canonical = canonicalForLocale(locale, PATH);
  const title = t("metaTitle", { brand: config.brandName });
  const description = t("metaDescription", { brand: config.brandName });
  const social = socialMetadata(locale, canonical);

  return {
    title,
    description,
    alternates: { canonical, languages: languageAlternates(PATH) },
    openGraph: { url: canonical, title: socialTitle(title), description, images: social.openGraph.images },
    twitter: { ...social.twitter, title: socialTitle(title), description },
  };
}

export default async function AccessModelPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "accessModel" });

  const brand = config.brandName;
  const hostLabel = config.issuer.replace(/^https?:\/\//, "");
  const repoLabel = config.sourceRepoUrl.replace(/^https?:\/\//, "");

  const link = (href: string) => (chunks: ReactNode) => (
    <a className={s.link} href={href}>
      {chunks}
    </a>
  );
  const values = {
    brand,
    hostLabel,
    repoLabel,
    issuesLabel: config.issuesLabel,
    tgApi: link(TELEGRAM_API_URL),
    tgTerms: link(TELEGRAM_TERMS_URL),
    repo: link(config.sourceRepoUrl),
    host: link(config.issuer),
    issues: link(config.issuesUrl),
    privacy: (chunks: ReactNode) => (
      <Link className={s.link} href="/privacy">
        {chunks}
      </Link>
    ),
  };

  // Indexed {term, desc} items, same flat-JSON pattern as the privacy page. The
  // key casts mirror that page: next-intl types keys as literals.
  const li = (ns: string, count: number) =>
    Array.from({ length: count }, (_, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, never reordered — namespace+index is a stable key.
      <li key={`${ns}.${i}`}>
        <strong>{t(`${ns}.${i}.term` as "access.items.0.term")}</strong> —{" "}
        {t.rich(`${ns}.${i}.desc` as "access.items.0.desc", values)}
      </li>
    ));

  return (
    <div className={s.container}>
      <h1 className={s.h1}>{t("title", { brand })}</h1>
      <p className={s.updated}>{t("lastUpdated", { date: t("updatedDate") })}</p>
      <p className={s.p}>{t("intro", { brand })}</p>

      <h2 className={s.h2}>{t("access.heading")}</h2>
      <ul className={s.ul}>{li("access.items", 4)}</ul>

      <h2 className={s.h2}>{t("adds.heading", { brand })}</h2>
      <ul className={s.ul}>{li("adds.items", 6)}</ul>

      <h2 className={s.h2}>{t("terms.heading", { brand })}</h2>
      <p className={s.p}>{t.rich("terms.body", values)}</p>
      <ul className={s.ul}>{li("terms.items", 4)}</ul>

      <h2 className={s.h2}>{t("reviewers.heading")}</h2>
      <p className={s.p}>{t.rich("reviewers.body", values)}</p>
    </div>
  );
}
