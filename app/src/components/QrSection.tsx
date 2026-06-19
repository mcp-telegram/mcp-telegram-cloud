export type QrSectionProps = {
  /** Localized "Loading QR code…" status text. */
  loadingText: string;
  /** Localized strings for the 2FA cloud-password step (revealed by the island
   *  when Telegram requires a password). */
  twoFactor: {
    title: string;
    description: string;
    passwordLabel: string;
    submit: string;
  };
};

/**
 * The QR display block shared by Login, Add-Account, and OAuth Authorize.
 * Hidden until the qr-flow island reveals it. DOM ids match the island's
 * contract (#qr-section, #qr-container, #status, #result, and the 2FA block
 * #password-section / #tfa-password / #tfa-submit).
 */
export function QrSection({ loadingText, twoFactor }: QrSectionProps) {
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

        {/* 2FA cloud-password step — hidden until the island receives a
            `password_needed` event, then revealed below the status line. */}
        <div id="password-section" style={{ display: "none", marginTop: 16, textAlign: "start" }}>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>{twoFactor.title}</h2>
          <p className="muted" style={{ marginBottom: 12 }}>
            {twoFactor.description}
          </p>
          <label htmlFor="tfa-password" style={{ fontSize: 14, fontWeight: 600 }}>
            {twoFactor.passwordLabel}
          </label>
          <input
            id="tfa-password"
            type="password"
            autoComplete="off"
            style={{ display: "block", width: "100%", margin: "8px 0 12px" }}
          />
          <button type="button" id="tfa-submit">
            {twoFactor.submit}
          </button>
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
