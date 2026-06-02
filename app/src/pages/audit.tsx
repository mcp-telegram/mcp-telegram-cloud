import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss } from "../theme.js";

export type AuditRow = {
  id: number;
  user_id: string;
  tool_name: string;
  args_summary: string;
  result: string;
  created_at: string;
};

export type AuditProps = {
  locale: string;
  username: string;
  rows: AuditRow[];
  /** Hashed island bundle URLs from the Vite client manifest. */
  scripts?: readonly string[];
};

/** Badge background/foreground colors keyed by result class. */
const badgeStyle = (result: string): { background: string; color: string } => {
  if (result === "ok") return { background: "rgba(49, 209, 88, .15)", color: "#1d8a3a" };
  if (result.startsWith("denied")) return { background: "rgba(229, 57, 53, .12)", color: "#E53935" };
  return { background: "rgba(0, 122, 255, .12)", color: "#007AFF" };
};

function labelFor(result: string): string {
  if (result === "ok") return "ok";
  if (result === "denied_disabled") return "denied (disabled)";
  if (result === "denied_quota") return "denied (quota)";
  return result;
}

function AuditPage(props: AuditProps) {
  const { locale, username, rows } = props;
  const t = createTranslator(getMessages(locale));

  return (
    <Layout
      locale={locale}
      title={`${t("common.brandName")} — ${t("audit.title")}`}
      description={t("audit.subtitle")}
      scripts={props.scripts}
      css={baseCss}
    >
      <main className="card" style={{ maxWidth: 880, textAlign: "start" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <h1>{t("audit.title")}</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              {t("audit.subtitle")} · {`@${username}`}
            </p>
          </div>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </header>

        {rows.length === 0 ? (
          <div
            className="muted"
            style={{
              background: "#F4F4F7",
              padding: 24,
              borderRadius: 12,
              textAlign: "center",
              fontSize: 14,
              marginTop: 16,
            }}
          >
            {t("audit.empty")}
          </div>
        ) : (
          <table style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>{t("audit.when")}</th>
                <th>{t("audit.tool")}</th>
                <th>{t("audit.client")}</th>
                <th>Args</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {r.created_at}
                  </td>
                  <td>{r.tool_name}</td>
                  <td>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        ...badgeStyle(r.result),
                      }}
                    >
                      {labelFor(r.result)}
                    </span>
                  </td>
                  <td
                    className="muted"
                    style={{
                      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
                      fontSize: 12,
                      wordBreak: "break-word",
                    }}
                  >
                    {r.args_summary || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <a href="/my/settings" style={{ display: "inline-block", marginTop: 24, fontSize: 14, textDecoration: "none" }}>
          ← {t("settings.title")}
        </a>
      </main>
    </Layout>
  );
}

/** Server entry: the Bun backend imports this and calls it per request. */
export function render(props: AuditProps): string {
  return `<!DOCTYPE html>${renderToString(<AuditPage {...props} />)}`;
}
