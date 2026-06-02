import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { createTranslator, getMessages } from "../i18n/index.js";

export type SettingsProps = {
  locale: string;
  username: string;
  enabled: boolean;
  todayCount: number;
  dailyLimit: number;
  /** Hashed island bundle URLs from the Vite client manifest. */
  scripts?: readonly string[];
  /** Design-token CSS injected into <head>. */
  css?: string;
};

function SettingsPage(props: SettingsProps) {
  const { locale, username, enabled, todayCount, dailyLimit } = props;
  const m = getMessages(locale);
  const t = createTranslator(m);
  const limitDisplay = dailyLimit > 0 ? `${todayCount} / ${dailyLimit}` : `${todayCount} / ∞`;

  return (
    <Layout
      locale={locale}
      title={`${t("common.brandName")} — ${t("settings.title")}`}
      scripts={props.scripts}
      css={props.css}
    >
      <main style={{ maxWidth: 560, margin: "0 auto", padding: "32px 20px", textAlign: "left" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <div>
            <h1 style={{ margin: 0 }}>{t("settings.title")}</h1>
            <p style={{ color: "#707579", marginTop: 4 }}>{`@${username}`}</p>
          </div>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </header>

        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 13, textTransform: "uppercase", color: "#707579" }}>{t("settings.accountSection")}</h2>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0" }}>
            <span>Destructive tools</span>
            <span style={{ color: "#707579", fontVariantNumeric: "tabular-nums" }}>
              {enabled ? "Enabled" : "Disabled"} · {limitDisplay}
            </span>
          </div>

          <form method="post" action="/my/settings">
            <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
            <button type="submit">{enabled ? t("settings.disconnect") : t("settings.save")}</button>
          </form>
        </section>
      </main>
    </Layout>
  );
}

/** Server entry: the Bun backend imports this and calls it per request. */
export function render(props: SettingsProps): string {
  return `<!DOCTYPE html>${renderToString(<SettingsPage {...props} />)}`;
}
