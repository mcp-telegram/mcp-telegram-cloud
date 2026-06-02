import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss } from "../theme.js";

export type SettingsProps = {
  locale: string;
  username: string;
  enabled: boolean;
  todayCount: number;
  dailyLimit: number;
  /** Optional flash message rendered above the form (e.g. after a POST). */
  flash?: string;
  /** Hashed island bundle URLs from the Vite client manifest. */
  scripts?: readonly string[];
};

function SettingsPage(props: SettingsProps) {
  const { locale, username, enabled, todayCount, dailyLimit, flash } = props;
  const t = createTranslator(getMessages(locale));
  const limitDisplay = dailyLimit > 0 ? `${todayCount} / ${dailyLimit}` : `${todayCount} / ∞`;

  return (
    <Layout
      locale={locale}
      title={`${t("common.brandName")} — ${t("settings.title")}`}
      description={t("settings.subtitle")}
      scripts={props.scripts}
      css={baseCss}
    >
      <main className="card" style={{ maxWidth: 560, textAlign: "start" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <h1>{t("settings.title")}</h1>
            <p className="muted" style={{ marginTop: 4 }}>{`@${username}`}</p>
          </div>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </header>

        {flash ? <div className="flash">{flash}</div> : null}

        <section style={{ marginTop: 24 }}>
          <h2>{t("settings.accountSection")}</h2>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0" }}>
            <span>Destructive tools</span>
            <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
              {enabled ? "Enabled" : "Disabled"} · {limitDisplay}
            </span>
          </div>

          <form method="post" action="/my/settings">
            <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
            <button type="submit" className={enabled ? "destructive" : undefined}>
              {enabled ? t("settings.disconnect") : t("settings.save")}
            </button>
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
