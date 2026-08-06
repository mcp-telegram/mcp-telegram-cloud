import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { TbCircleCheck, TbClockHour4, TbLock } from "react-icons/tb";
import { CopyableUrl } from "@/components/docs/CopyableUrl";
import { StepCard, Stepper } from "@/components/docs/StepCard";
import { Troubleshooting } from "@/components/docs/Troubleshooting";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates, socialMetadata } from "@/lib/seo";
import s from "../../doc.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const PATH = "/docs/oauth";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "oauthDocs" });
  const canonical = canonicalForLocale(locale, PATH);
  const social = socialMetadata(locale, canonical);

  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical, languages: languageAlternates(PATH) },
    openGraph: {
      url: canonical,
      title: t("metaTitle"),
      description: t("metaDescription"),
      images: social.openGraph.images,
    },
    twitter: { ...social.twitter, title: t("metaTitle"), description: t("metaDescription") },
  };
}

export default async function OAuthDocsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Body />;
}

function Body() {
  const t = useTranslations("oauthDocs");
  const mcpUrl = `${config.mcpBaseUrl}/mcp`;
  const registerUrl = `${config.mcpBaseUrl}/oauth/register`;
  const authorizeUrl = `${config.mcpBaseUrl}/oauth/authorize`;
  const tokenUrl = `${config.mcpBaseUrl}/oauth/token`;
  const metadataUrl = `${config.mcpBaseUrl}/.well-known/oauth-authorization-server`;

  return (
    <main className={s.container}>
      <Link href="/docs/quickstart" className={s.backLink}>
        ← {t("backToQuickstart")}
      </Link>

      <h1 className={s.h1}>{t("heading")}</h1>
      <p className={s.lead}>{t("lead")}</p>

      <h2 className={s.h2}>{t("rfcHeading")}</h2>
      <p className={s.desc}>{t("rfcLead")}</p>
      <div className={s.checkList}>
        <div className={s.checkRow}>
          <TbCircleCheck size={19} className={s.checkIcon} aria-hidden />
          <span>
            <strong>RFC 6749</strong> — {t("rfc6749")}
          </span>
        </div>
        <div className={s.checkRow}>
          <TbCircleCheck size={19} className={s.checkIcon} aria-hidden />
          <span>
            <strong>RFC 7591</strong> — {t("rfc7591")}
          </span>
        </div>
        <div className={s.checkRow}>
          <TbCircleCheck size={19} className={s.checkIcon} aria-hidden />
          <span>
            <strong>RFC 7636</strong> — {t("rfc7636")}
          </span>
        </div>
        <div className={s.checkRow}>
          <TbCircleCheck size={19} className={s.checkIcon} aria-hidden />
          <span>
            <strong>RFC 8252</strong> — {t("rfc8252")}
          </span>
        </div>
        <div className={s.checkRow}>
          <TbCircleCheck size={19} className={s.checkIcon} aria-hidden />
          <span>
            <strong>RFC 8414</strong> — {t("rfc8414")}
          </span>
        </div>
        <div className={s.checkRow}>
          <TbCircleCheck size={19} className={s.checkIcon} aria-hidden />
          <span>
            <strong>RFC 9728</strong> — {t("rfc9728")}
          </span>
        </div>
      </div>

      <h2 className={s.h2}>{t("endpointsHeading")}</h2>
      <div className={s.endpoints}>
        <CopyableUrl
          url={metadataUrl}
          label={t("endpointMetadata")}
          copyLabel={t("copyLabel")}
          copiedLabel={t("copiedLabel")}
        />
        <CopyableUrl
          url={registerUrl}
          label={t("endpointRegister")}
          copyLabel={t("copyLabel")}
          copiedLabel={t("copiedLabel")}
        />
        <CopyableUrl
          url={authorizeUrl}
          label={t("endpointAuthorize")}
          copyLabel={t("copyLabel")}
          copiedLabel={t("copiedLabel")}
        />
        <CopyableUrl
          url={tokenUrl}
          label={t("endpointToken")}
          copyLabel={t("copyLabel")}
          copiedLabel={t("copiedLabel")}
        />
        <CopyableUrl url={mcpUrl} label={t("endpointMcp")} copyLabel={t("copyLabel")} copiedLabel={t("copiedLabel")} />
      </div>

      <h2 className={s.h2}>{t("flowHeading")}</h2>
      <p className={s.desc}>{t("flowLead")}</p>
      <Stepper>
        <StepCard num={1} title={t("flowStep1Title")} description={t("flowStep1Desc")} />
        <StepCard num={2} title={t("flowStep2Title")} description={t("flowStep2Desc")} />
        <StepCard num={3} title={t("flowStep3Title")} description={t("flowStep3Desc")} />
        <StepCard num={4} title={t("flowStep4Title")} description={t("flowStep4Desc")} />
        <StepCard num={5} title={t("flowStep5Title")} description={t("flowStep5Desc")} />
      </Stepper>

      <h2 className={s.h2}>{t("redirectUriHeading")}</h2>
      <p className={s.desc}>{t("redirectUriLead")}</p>

      <h3 className={s.h3}>{t("redirectUriLoopbackTitle")}</h3>
      <p className={s.desc}>{t("redirectUriLoopbackDesc")}</p>
      <ul className={s.list}>
        <li>{t("redirectUriLoopbackRule1")}</li>
        <li>{t("redirectUriLoopbackRule2")}</li>
        <li>{t("redirectUriLoopbackRule3")}</li>
      </ul>

      <h3 className={s.h3}>{t("redirectUriHttpsTitle")}</h3>
      <p className={s.desc}>{t("redirectUriHttpsDesc")}</p>

      <h3 className={s.h3}>{t("redirectUriLocalhostTitle")}</h3>
      <p className={s.desc}>{t("redirectUriLocalhostDesc")}</p>

      <div className={`${s.note} ${s.noteAccent}`}>
        <TbLock size={19} color="var(--tg-link)" className={s.noteIcon} aria-hidden />
        <span>
          <span className={s.noteTitle}>{t("pkceHeading")}</span>
          {t("pkceDesc")}
        </span>
      </div>

      <div className={s.note}>
        <TbClockHour4 size={19} color="var(--tg-link)" className={s.noteIcon} aria-hidden />
        <span>
          <span className={s.noteTitle}>{t("tokenLifetimeHeading")}</span>
          {t("tokenLifetimeDesc")}
        </span>
      </div>

      <h2 className={s.h2}>{t("troubleshootHeading")}</h2>
      <Troubleshooting
        items={[
          { title: t("troubleshootInvalidRedirectTitle"), body: t("troubleshootInvalidRedirectDesc") },
          { title: t("troubleshootUnknownClientTitle"), body: t("troubleshootUnknownClientDesc") },
          { title: t("troubleshootNeedsAuthTitle"), body: t("troubleshootNeedsAuthDesc") },
        ]}
      />

      <h2 className={s.h2}>{t("testedClientsHeading")}</h2>
      <p className={s.desc}>{t("testedClientsLead")}</p>
      <div className={s.checkList}>
        {(
          [
            "testedClientClaude",
            "testedClientChatGPT",
            "testedClientHermes",
            "testedClientCursor",
            "testedClientGeneric",
          ] as const
        ).map((key) => (
          <div key={key} className={s.checkRow}>
            <TbCircleCheck size={19} className={s.checkIcon} aria-hidden />
            <span>{t(key)}</span>
          </div>
        ))}
      </div>

      <h2 className={s.h2}>{t("multiAccountHeading")}</h2>
      <p className={s.desc}>{t("multiAccountLead")}</p>
      <Stepper>
        <StepCard num={1} title={t("multiAccountStep1Title")} description={t("multiAccountStep1Desc")} />
        <StepCard num={2} title={t("multiAccountStep2Title")} description={t("multiAccountStep2Desc")} />
        <StepCard num={3} title={t("multiAccountStep3Title")} description={t("multiAccountStep3Desc")} />
        <StepCard num={4} title={t("multiAccountStep4Title")} description={t("multiAccountStep4Desc")} />
      </Stepper>
      <p className={s.desc}>{t("multiAccountSecurityNote")}</p>
    </main>
  );
}
