import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { QrSection, qrCss } from "../components/QrSection.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss } from "../theme.js";

export type AuthorizeProps = {
  locale: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scripts?: readonly string[];
};

function AuthorizePage(props: AuthorizeProps) {
  const { locale, clientName } = props;
  const t = createTranslator(getMessages(locale));

  // Build the SSE URL server-side so the island stays a plain data consumer.
  const qs = new URLSearchParams({
    client_id: props.clientId,
    redirect_uri: props.redirectUri,
    state: props.state,
    code_challenge: props.codeChallenge,
    code_challenge_method: props.codeChallengeMethod,
  });
  const sseUrl = `/oauth/authorize/qr?${qs.toString()}`;

  return (
    <Layout
      locale={locale}
      title={`${t("common.brandName")} — ${t("login.title")}`}
      scripts={props.scripts}
      css={baseCss + qrCss}
    >
      <main
        className="card"
        style={{ maxWidth: 480, textAlign: "center" }}
        data-island="qr-flow"
        data-auto="1"
        data-sse-url={sseUrl}
        data-cookie-url="/oauth/authorize/qr/cookie"
        data-msg-connected={t("login.connected")}
        data-msg-redirecting={t("common.redirecting")}
        data-msg-lost={t("login.connectionLost")}
      >
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </div>
        <h1>{t("common.brandName")}</h1>
        <p className="muted">
          {clientName ? `${clientName} · ` : ""}
          {t("login.title")}
        </p>

        <QrSection loadingText={t("login.connecting")} />
      </main>
    </Layout>
  );
}

export function render(props: AuthorizeProps): string {
  return `<!DOCTYPE html>${renderToString(<AuthorizePage {...props} />)}`;
}
