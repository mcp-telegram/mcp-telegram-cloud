import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { Layout } from "../components/Layout.js";
import { createTranslator, getMessages } from "../i18n/index.js";
import { baseCss } from "../theme.js";

export type UploadRow = {
  id: string;
  mime: string;
  size: number;
  original_name: string | null;
  expires_at: string;
};

export type UploadsProps = {
  locale: string;
  username: string;
  rows: UploadRow[];
  fileMaxBytes: number;
  quotaBytes: number;
  ttlSeconds: number;
  pendingBytes: number;
  flash?: string;
  scripts?: readonly string[];
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const uploadsCss = `
#dz { border: 2px dashed rgba(0,0,0,.15); border-radius: 12px; padding: 28px; text-align: center; cursor: pointer; display: flex; flex-direction: column; gap: 6px; color: #707579; }
#dz.dragging { border-color: #007AFF; background: #F4F4F7; }
.quota-bar { height: 6px; background: rgba(0,0,0,.06); border-radius: 3px; margin-top: 6px; overflow: hidden; }
.quota-fill { height: 100%; background: #007AFF; }
.copy-btn { margin-inline-start: 8px; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
`;

function UploadsPage(props: UploadsProps) {
  const { locale, username, rows, fileMaxBytes, quotaBytes, pendingBytes, flash } = props;
  const t = createTranslator(getMessages(locale));
  const pct = quotaBytes > 0 ? Math.min(100, Math.round((pendingBytes / quotaBytes) * 100)) : 0;

  return (
    <Layout
      locale={locale}
      title={`${t("common.brandName")} — ${t("uploads.title")}`}
      description={t("uploads.subtitle")}
      scripts={props.scripts}
      css={baseCss + uploadsCss}
    >
      <main className="card" style={{ maxWidth: 880, textAlign: "start" }} data-island="uploads">
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <h1>{t("uploads.title")}</h1>
            <p className="muted" style={{ marginTop: 4 }}>{`@${username}`}</p>
          </div>
          <LanguageSwitcher current={locale} label={t("common.languageLabel")} />
        </header>

        {flash ? <div className="flash">{flash}</div> : null}

        {/* data-msg-* feed localized strings to the island (which is i18n-agnostic). */}
        <div
          id="dz"
          data-msg-uploading={t("uploads.uploading")}
          data-msg-uploaded={t("uploads.uploaded")}
          data-msg-failed={t("uploads.uploadFailed")}
          data-msg-network={t("uploads.networkError")}
          data-msg-copied={t("uploads.copied")}
        >
          <span style={{ fontWeight: 600, color: "#000" }}>{t("uploads.dropzone")}</span>
          <span>{formatBytes(fileMaxBytes)}</span>
          <input id="file-input" type="file" style={{ display: "none" }} />
        </div>
        <div id="upload-status" className="muted" style={{ minHeight: 20, marginTop: 8 }} />

        <div className="muted" style={{ marginTop: 12 }}>
          {t("uploads.quota")}: {formatBytes(pendingBytes)} / {formatBytes(quotaBytes)} {t("uploads.quotaPending")} (
          {pct}
          %)
          <div className="quota-bar">
            <div className="quota-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>
            {t("uploads.empty")}
          </p>
        ) : (
          <table style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>{t("uploads.uploadId")}</th>
                <th>{t("uploads.file")}</th>
                <th>{t("uploads.size")}</th>
                <th>{t("uploads.mime")}</th>
                <th>{t("uploads.expires")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">
                    {r.id}
                    <button type="button" className="copy-btn" data-copy-id={r.id}>
                      {t("uploads.copy")}
                    </button>
                  </td>
                  <td>{r.original_name ?? "—"}</td>
                  <td className="muted">{formatBytes(r.size)}</td>
                  <td className="muted">{r.mime}</td>
                  <td className="muted">{r.expires_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <nav style={{ marginTop: 24, display: "flex", gap: 16 }}>
          <a href="/my/settings">← {t("settings.title")}</a>
          <a href="/my/audit">{t("audit.title")} →</a>
        </nav>
      </main>
    </Layout>
  );
}

export function render(props: UploadsProps): string {
  return `<!DOCTYPE html>${renderToString(<UploadsPage {...props} />)}`;
}
