import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { QrSection, qrCss } from "../components/QrSection.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss } from "../theme.js";

export type LoginProps = {
  locale: string;
  scripts?: readonly string[];
};

function LoginPage(props: LoginProps) {
  const { locale } = props;
  const t = createTranslator(getMessages(locale));

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
        data-sse-url-template="/login/qr?userId={userId}"
        data-password-url="/qr/password"
        data-msg-connected={t("login.connected")}
        data-msg-saved={t("login.sessionSaved")}
        data-msg-lost={t("login.connectionLost")}
      >
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </div>
        <h1>{t("common.brandName")}</h1>
        <p className="muted">{t("login.title")}</p>

        <div id="login-form" style={{ textAlign: "start", marginTop: 16 }}>
          <label htmlFor="userId" style={{ fontSize: 14, fontWeight: 600 }}>
            {t("login.usernameLabel")}
          </label>
          <input
            id="userId"
            type="text"
            placeholder={t("login.usernamePlaceholder")}
            // biome-ignore lint/a11y/noAutofocus: single-field entry page, focus is expected here.
            autoFocus
            style={{ display: "block", width: "100%", margin: "8px 0 16px" }}
          />
          <button type="button" id="startBtn">
            {t("login.startButton")}
          </button>
          <div className="step" style={{ marginTop: 12 }}>
            1. {t("login.step1")}
          </div>
          <div className="step">2. {t("login.step2")}</div>
          <div className="step">3. {t("login.step3")}</div>
        </div>

        <QrSection
          loadingText={t("login.connecting")}
          twoFactor={{
            title: t("twoFactor.title"),
            description: t("twoFactor.description"),
            passwordLabel: t("twoFactor.passwordLabel"),
            submit: t("twoFactor.submit"),
          }}
        />
      </main>
    </Layout>
  );
}

export function render(props: LoginProps): string {
  return `<!DOCTYPE html>${renderToString(<LoginPage {...props} />)}`;
}
