import { css, cx } from "hono/css";
import type { FC } from "hono/jsx";
import { config } from "../config.js";
import { card, subtitle, tg, title } from "../styles.js";
import type { UploadRow } from "../upload-store.js";
import { Layout } from "./Layout.js";

export interface UploadsPageProps {
  username: string;
  rows: UploadRow[];
  fileMaxBytes: number;
  quotaBytes: number;
  ttlSeconds: number;
  pendingBytes: number;
  flash?: string;
}

const wide = css`
  max-width: 880px;
  text-align: left;
`;

const dropzone = css`
  border: 2px dashed ${tg.outline};
  border-radius: 12px;
  padding: 40px 16px;
  text-align: center;
  background: ${tg.tertiaryBg};
  color: ${tg.hint};
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  &:hover, &.dragging {
    background: rgba(0, 122, 255, 0.06);
    border-color: ${tg.link};
  }
`;

const dropzoneTitle = css`
  display: block;
  font-size: 15px;
  font-weight: 600;
  color: ${tg.text};
  margin-bottom: 6px;
`;

const limits = css`
  font-size: 12px;
  color: ${tg.hint};
  margin-top: 12px;
  text-align: center;
`;

const tbl = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  margin-top: 16px;
  & th {
    text-align: left;
    padding: 10px 12px;
    background: ${tg.tertiaryBg};
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${tg.hint};
  }
  & td {
    padding: 10px 12px;
    border-bottom: 1px solid ${tg.outline};
    vertical-align: top;
  }
  & tr:last-child td {
    border-bottom: none;
  }
`;

const idCell = css`
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
  color: ${tg.text};
  word-break: break-all;
`;

const copyBtn = css`
  display: inline-block;
  padding: 2px 8px;
  margin-left: 6px;
  border-radius: 4px;
  border: 1px solid ${tg.outline};
  background: ${tg.bg};
  color: ${tg.link};
  font-size: 11px;
  cursor: pointer;
  &:hover { background: ${tg.tertiaryBg}; }
`;

const dim = css`
  color: ${tg.hint};
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`;

const flashOk = css`
  background: rgba(49, 209, 88, .12);
  color: #1d8a3a;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
`;

const flashErr = css`
  background: rgba(229, 57, 53, .12);
  color: ${tg.destructive};
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
`;

const navLink = css`
  display: inline-block;
  margin-top: 24px;
  margin-right: 16px;
  color: ${tg.link};
  text-decoration: none;
  font-size: 14px;
  &:hover { text-decoration: underline; }
`;

const empty = css`
  background: ${tg.tertiaryBg};
  padding: 24px;
  border-radius: 12px;
  color: ${tg.hint};
  text-align: center;
  font-size: 14px;
  margin-top: 16px;
`;

const quotaBar = css`
  height: 6px;
  background: ${tg.tertiaryBg};
  border-radius: 3px;
  margin: 8px 0 4px;
  overflow: hidden;
`;

const quotaFill = css`
  height: 100%;
  background: ${tg.link};
`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

const inlineScript = `
(function () {
  var dz = document.getElementById('dz');
  var input = document.getElementById('file-input');
  var status = document.getElementById('upload-status');
  if (!dz || !input || !status) return;
  function setStatus(msg, isErr) {
    status.textContent = msg;
    status.style.color = isErr ? '#e53935' : '';
  }
  function upload(file) {
    if (!file) return;
    setStatus('Uploading ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)…');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/my/upload', true);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var resp = JSON.parse(xhr.responseText);
          setStatus('Uploaded. ID: ' + resp.id);
          // Reload to render the new row in the table.
          setTimeout(function () { window.location.reload(); }, 600);
        } catch (e) {
          setStatus('Upload OK but response unreadable: ' + e.message, true);
        }
      } else {
        var msg = 'Upload failed (' + xhr.status + ')';
        try { var resp = JSON.parse(xhr.responseText); if (resp && resp.message) msg = resp.message; } catch (e) {}
        setStatus(msg, true);
      }
    };
    xhr.onerror = function () { setStatus('Network error', true); };
    var fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  }
  dz.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () { upload(input.files && input.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragging'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragging'); });
  });
  dz.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) upload(f);
  });
})();

document.addEventListener('click', function (e) {
  var t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset && t.dataset.copyId) {
    navigator.clipboard.writeText(t.dataset.copyId).then(function () {
      var orig = t.textContent;
      t.textContent = 'copied';
      setTimeout(function () { t.textContent = orig; }, 1200);
    });
  }
});
`;

export const UploadsPage: FC<UploadsPageProps> = ({
  username,
  rows,
  fileMaxBytes,
  quotaBytes,
  ttlSeconds,
  pendingBytes,
  flash,
}) => {
  const pct = Math.min(100, Math.round((pendingBytes / quotaBytes) * 100));
  const isErr = flash?.startsWith("Error:") || flash?.startsWith("Upload");

  return (
    <Layout title={`${config.brandName} — Uploads`} description="Upload files for use with Telegram send tools.">
      <div class={cx(card, wide)}>
        <h1 class={title}>Uploads</h1>
        <p class={subtitle}>
          Pending uploads for <strong>@{username}</strong>. Drop a file here, copy its ID, then ask the LLM to send it.
        </p>

        {flash ? <div class={isErr ? flashErr : flashOk}>{flash}</div> : null}

        <div id="dz" class={dropzone}>
          <span class={dropzoneTitle}>Drop a file here, or click to choose</span>
          <span>
            Up to {formatBytes(fileMaxBytes)} per file. Stored for {formatDuration(ttlSeconds)}.
          </span>
          <input id="file-input" type="file" style="display:none" />
        </div>
        <div id="upload-status" class={limits}>
          {" "}
        </div>

        <div class={limits}>
          Quota: {formatBytes(pendingBytes)} / {formatBytes(quotaBytes)} pending ({pct}%)
          <div class={quotaBar}>
            <div class={quotaFill} style={`width: ${pct}%`} />
          </div>
        </div>

        {rows.length === 0 ? (
          <div class={empty}>No pending uploads. Drop a file above to begin.</div>
        ) : (
          <table class={tbl}>
            <thead>
              <tr>
                <th>Upload ID</th>
                <th>File</th>
                <th>Size</th>
                <th>MIME</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class={idCell}>
                    {r.id}
                    <button type="button" class={copyBtn} data-copy-id={r.id}>
                      copy
                    </button>
                  </td>
                  <td>{r.original_name ?? "—"}</td>
                  <td class={dim}>{formatBytes(r.size)}</td>
                  <td class={dim}>{r.mime}</td>
                  <td class={dim}>{r.expires_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div>
          <a class={navLink} href="/my/settings">
            ← Settings
          </a>
          <a class={navLink} href="/my/audit">
            Audit log →
          </a>
        </div>

        <script dangerouslySetInnerHTML={{ __html: inlineScript }} />
      </div>
    </Layout>
  );
};
