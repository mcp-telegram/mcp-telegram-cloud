/** Shared layout for feature-guide pages (multi-account, stories, uploads).
 *
 * Each guide pulls its content from a single i18n namespace (`featureGuides`)
 * keyed by `slug` — e.g. `multiAccount.heading`, `multiAccount.step1Title`.
 *
 * Structure: intro lead → 3-5 numbered StepCards → "Try these prompts" list →
 * Troubleshooting. Mirrors the proven /docs/quickstart/{claude,chatgpt} shape
 * so users get a familiar surface and we reuse the StepCard component. */

import { useTranslations } from "next-intl";
import s from "@/app/[locale]/doc.module.css";
import { StepCard, Stepper } from "@/components/docs/StepCard";
import { Troubleshooting } from "@/components/docs/Troubleshooting";
import { Link } from "@/i18n/navigation";

type Props = {
  slug: "multiAccount" | "stories" | "uploads";
  stepCount: number;
  troubleshootCount: number;
};

export function FeatureGuide({ slug, stepCount, troubleshootCount }: Props) {
  const t = useTranslations(`featureGuides.${slug}`);

  return (
    <main className={s.container}>
      <Link href="/docs/quickstart" className={s.backLink}>
        ← {t("backToOverview")}
      </Link>

      <h1 className={s.h1}>{t("heading")}</h1>
      <p className={s.lead}>{t("intro")}</p>

      <Stepper>
        {Array.from({ length: stepCount }, (_, i) => i + 1).map((n) => (
          <StepCard
            key={n}
            num={n}
            title={t(`step${n}Title` as "step1Title")}
            description={t(`step${n}Desc` as "step1Desc")}
          />
        ))}
      </Stepper>

      <h2 className={s.h2}>{t("promptsHeading")}</h2>
      <div className={s.promptList}>
        <p className={s.promptBubble}>«{t("prompt1")}»</p>
        <p className={s.promptBubble}>«{t("prompt2")}»</p>
        <p className={s.promptBubble}>«{t("prompt3")}»</p>
      </div>

      <h2 className={s.h2}>{t("troubleshootHeading")}</h2>
      <Troubleshooting
        items={Array.from({ length: troubleshootCount }, (_, i) => i + 1).map((n) => ({
          title: t(`troubleshoot${n}Title` as "troubleshoot1Title"),
          body: t(`troubleshoot${n}Desc` as "troubleshoot1Desc"),
        }))}
      />
    </main>
  );
}
