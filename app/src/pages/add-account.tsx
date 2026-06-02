import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { QrSection, qrCss } from "../components/QrSection.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss } from "../theme.js";

export type AddAccountProps = {
  locale: string;
  token: string;
  label: string | null;
  scripts?: readonly string[];
};

function AddAccountPage(props: AddAccountProps) {
  const { locale, token, label } = props;
  const t = createTranslator(getMessages(locale));

  return (
    <Layout
      locale={locale}
      title={`${t("common.brandName")} — ${t("addAccount.title")}`}
      description={t("addAccount.subtitle")}
      scripts={props.scripts}
      css={baseCss + qrCss}
    >
      <main
        className="card"
        style={{ maxWidth: 520, textAlign: "center" }}
        data-island="qr-flow"
        data-sse-url={`/accounts/add/${token}/qr`}
        data-msg-added={t("addAccount.added")}
        data-msg-saved={t("addAccount.accountActive")}
        data-msg-lost={t("common.connectionLost")}
      >
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </div>
        <h1>{t("addAccount.title")}</h1>
        <p className="muted">
          {t("addAccount.subtitle")}
          {label ? ` (${label})` : ""}
        </p>

        <div id="intro" style={{ textAlign: "start", marginTop: 16 }}>
          <div className="step">1. {t("addAccount.step1")}</div>
          <div className="step">2. {t("addAccount.step2")}</div>
          <div className="step">3. {t("addAccount.step3")}</div>
          <button type="button" id="startBtn" style={{ marginTop: 16 }}>
            {t("addAccount.startScan")}
          </button>
        </div>

        <QrSection loadingText={t("common.qrLoading")} />
      </main>
    </Layout>
  );
}

export function render(props: AddAccountProps): string {
  return `<!DOCTYPE html>${renderToString(<AddAccountPage {...props} />)}`;
}
