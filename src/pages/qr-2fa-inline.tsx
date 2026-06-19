import type { FC } from "hono/jsx";
import { button, hidden, input, label, subtitle, title } from "../styles.js";

/**
 * 2FA cloud-password step for the legacy (non-React fallback) QR pages.
 *
 * The primary UI is the `app/` React island (qr-flow.ts); these Hono pages are
 * the build-less fallback. Both must understand the `password_needed` SSE event
 * the backend now emits, otherwise the fallback would hang when an account has
 * a cloud password. {@link TwoFactorBlock} is the hidden prompt markup;
 * {@link twoFactorSetupScript} wires it to an EventSource.
 */
export const TwoFactorBlock: FC = () => {
  return (
    <div id="password-section" class={hidden} style="margin-top:16px;text-align:left">
      <h2 class={title} style="font-size:18px">
        Two-factor authentication
      </h2>
      <p class={subtitle} style="margin-bottom:12px">
        This account is protected by a Telegram cloud password. Enter it to finish signing in.
      </p>
      <label class={label} for="tfa-password">
        Cloud password
      </label>
      <input class={input} type="password" id="tfa-password" autocomplete="off" />
      <button type="button" class={button} id="tfa-submit">
        Confirm
      </button>
    </div>
  );
};

/**
 * Defines `window.__setupTwoFactor(es)` — call it right after creating an
 * EventSource. It attaches a `password_needed` handler (reveal the prompt) and
 * wires the submit button to POST the password to `/qr/password`. The submit
 * wiring guards against double-binding so it is safe to call per attempt.
 */
export const twoFactorSetupScript = `
  window.__qrLoginId = '';
  // Shared HTML-escape for values interpolated into innerHTML by the legacy
  // result cards (Telegram display name / username / account label come from
  // getMe()/user input and may contain markup). Lives here because all three
  // legacy QR pages already include this script.
  window.__esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  window.__setupTwoFactor = function (es) {
    var pwSection = document.getElementById('password-section');
    var pwInput = document.getElementById('tfa-password');
    var pwSubmit = document.getElementById('tfa-submit');
    var qrContainer = document.getElementById('qr-container');
    if (!pwSection || !pwInput || !pwSubmit) return;

    function setEnabled(on) {
      pwInput.disabled = !on;
      pwSubmit.disabled = !on;
    }
    function submit() {
      var value = pwInput.value || '';
      if (!value || !window.__qrLoginId) return;
      setEnabled(false);
      fetch('/qr/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: window.__qrLoginId, password: value }),
        credentials: 'same-origin',
      }).catch(function () { setEnabled(true); });
    }

    es.addEventListener('password_needed', function (e) {
      var data = JSON.parse(e.data);
      window.__qrLoginId = data.loginId || '';
      if (qrContainer) qrContainer.style.display = 'none';
      pwSection.style.display = 'block';
      pwInput.value = '';
      setEnabled(true);
      pwInput.focus();
    });

    if (!window.__twoFactorWired) {
      window.__twoFactorWired = true;
      pwSubmit.addEventListener('click', submit);
      pwInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    }
  };
`;
