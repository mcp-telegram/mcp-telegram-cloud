/** Shared cookie-consent helpers for the content site.
 *
 * Consent is a tiny three-state value persisted in localStorage:
 *   - null      → not decided yet (show banner, load no trackers)
 *   - "granted" → load Yandex.Metrika + GA4
 *   - "denied"  → load nothing
 *
 * <ConsentBanner> writes it; <Analytics> reads it. They sync via a custom
 * `mcpt-consent-change` event (same-tab) and the native `storage` event
 * (cross-tab). Keep this module client-safe — it only touches localStorage,
 * which is guarded so it can be imported into either component without SSR
 * blowups. */

export const CONSENT_KEY = "mcpt-consent";
export const CONSENT_EVENT = "mcpt-consent-change";

export type Consent = "granted" | "denied" | null;

export function readConsent(): Consent {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    // localStorage can throw in privacy modes / disabled storage.
    return null;
  }
}

export function writeConsent(value: Exclude<Consent, null>): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Best-effort; if storage is unavailable the banner just re-appears.
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT));
}
