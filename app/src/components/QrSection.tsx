export type QrSectionProps = {
  /** Localized "Loading QR code…" status text. */
  loadingText: string;
};

/**
 * The QR display block shared by Login, Add-Account, and OAuth Authorize.
 * Hidden until the qr-flow island reveals it. DOM ids match the island's
 * contract (#qr-section, #qr-container, #status, #result).
 */
export function QrSection({ loadingText }: QrSectionProps) {
  return (
    <>
      <div id="qr-section" style={{ display: "none", textAlign: "center" }}>
        <div
          id="qr-container"
          style={{ display: "flex", justifyContent: "center", minHeight: 200, alignItems: "center" }}
        >
          <div className="spinner" />
        </div>
        <div id="status" className="muted" style={{ marginTop: 12 }}>
          {loadingText}
        </div>
      </div>
      <div id="result" style={{ display: "none" }} />
    </>
  );
}

/** Spinner keyframes + class — append to a page's CSS. */
export const qrCss = `
.spinner { width: 32px; height: 32px; border: 3px solid rgba(0,0,0,.1); border-top-color: #007AFF; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#qr-container img { width: 220px; height: 220px; }
.step { padding: 8px 0; font-size: 14px; }
`;
