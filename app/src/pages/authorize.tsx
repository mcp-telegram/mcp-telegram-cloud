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
        data-password-url="/qr/password"
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

        <QrSection
          loadingText={t("login.connecting")}
          twoFactor={{
            title: t("twoFactor.title"),
            description: t("twoFactor.description"),
            passwordLabel: t("twoFactor.passwordLabel"),
            submit: t("twoFactor.submit"),
          }}
        />

        {/*
          Recovery line for directory reviewers, who cannot scan this code at
          all: they have no phone signed into the demo account. Their access is
          granted per browser, so landing here means the authorization opened
          somewhere the review link was never opened — a private window, a
          different browser, an in-app webview. Without this line that is a dead
          end that reads as "the server would not let us in".

          Deliberately English-only and deliberately quiet: it is addressed to a
          handful of reviewers, not to users, and translating it into all 20
          locales would spend real effort on an audience that does not exist.
        */}
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: "1.5rem", opacity: 0.7 }}>
          Reviewing this connector? Open your review link in this browser, then try again.
        </p>
      </main>
    </Layout>
  );
}

export function render(props: AuthorizeProps): string {
  return `<!DOCTYPE html>${renderToString(<AuthorizePage {...props} />)}`;
}
