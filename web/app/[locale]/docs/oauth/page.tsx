import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CopyableUrl } from "@/components/docs/CopyableUrl";
import { StepCard } from "@/components/docs/StepCard";
import { Link } from "@/i18n/navigation";
import { config } from "@/lib/config";
import { canonicalForLocale, languageAlternates } from "@/lib/seo";
import s from "../../doc.module.css";

type PageProps = { params: Promise<{ locale: string }> };

const PATH = "/docs/oauth";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "oauthDocs" });
  const canonical = canonicalForLocale(locale, PATH);
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical, languages: languageAlternates(PATH) },
    openGraph: { url: canonical, title: t("metaTitle"), description: t("metaDescription") },
    twitter: { title: t("metaTitle"), description: t("metaDescription") },
  };
}

export default async function OAuthDocsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Body />;
}

function Body() {
  const t = useTranslations("oauthDocs");
  const mcpUrl = `${config.issuer}/mcp`;
  const registerUrl = `${config.issuer}/oauth/register`;
  const authorizeUrl = `${config.issuer}/oauth/authorize`;
  const tokenUrl = `${config.issuer}/oauth/token`;
  const metadataUrl = `${config.issuer}/.well-known/oauth-authorization-server`;

  return (
    <main className={s.container}>
      <Link href="/docs/quickstart" className={s.backLink}>
        ← {t("backToQuickstart")}
      </Link>

      <h1 className={s.h1}>{t("heading")}</h1>
      <p className={s.lead}>{t("lead")}</p>

      <h2 className={s.h2}>{t("rfcHeading")}</h2>
      <p className={s.desc}>{t("rfcLead")}</p>
      <ul className={s.list}>
        <li>
          <strong>RFC 6749</strong> — {t("rfc6749")}
        </li>
        <li>
          <strong>RFC 7591</strong> — {t("rfc7591")}
        </li>
        <li>
          <strong>RFC 7636</strong> — {t("rfc7636")}
        </li>
        <li>
          <strong>RFC 8252</strong> — {t("rfc8252")}
        </li>
        <li>
          <strong>RFC 8414</strong> — {t("rfc8414")}
        </li>
        <li>
          <strong>RFC 9728</strong> — {t("rfc9728")}
        </li>
      </ul>

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
      <StepCard num={1} title={t("flowStep1Title")} description={t("flowStep1Desc")} />
      <StepCard num={2} title={t("flowStep2Title")} description={t("flowStep2Desc")} />
      <StepCard num={3} title={t("flowStep3Title")} description={t("flowStep3Desc")} />
      <StepCard num={4} title={t("flowStep4Title")} description={t("flowStep4Desc")} />
      <StepCard num={5} title={t("flowStep5Title")} description={t("flowStep5Desc")} />

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

      <h2 className={s.h2}>{t("pkceHeading")}</h2>
      <p className={s.desc}>{t("pkceDesc")}</p>

      <h2 className={s.h2}>{t("tokenLifetimeHeading")}</h2>
      <p className={s.desc}>{t("tokenLifetimeDesc")}</p>

      <h2 className={s.h2}>{t("troubleshootHeading")}</h2>
      <div className={s.tsList}>
        <div className={s.tsItem}>
          <h3>{t("troubleshootInvalidRedirectTitle")}</h3>
          <p>{t("troubleshootInvalidRedirectDesc")}</p>
        </div>
        <div className={s.tsItem}>
          <h3>{t("troubleshootUnknownClientTitle")}</h3>
          <p>{t("troubleshootUnknownClientDesc")}</p>
        </div>
        <div className={s.tsItem}>
          <h3>{t("troubleshootNeedsAuthTitle")}</h3>
          <p>{t("troubleshootNeedsAuthDesc")}</p>
        </div>
      </div>

      <h2 className={s.h2}>{t("testedClientsHeading")}</h2>
      <p className={s.desc}>{t("testedClientsLead")}</p>
      <ul className={s.list}>
        <li>{t("testedClientClaude")}</li>
        <li>{t("testedClientChatGPT")}</li>
        <li>{t("testedClientHermes")}</li>
        <li>{t("testedClientCursor")}</li>
        <li>{t("testedClientGeneric")}</li>
      </ul>
    </main>
  );
}
