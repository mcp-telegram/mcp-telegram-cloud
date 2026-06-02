/**
 * Hydration entry for the language switcher.
 *
 * The control is SSR'd as a real `<select data-island="language-switcher">`.
 * This script (loaded once per page that includes the island) attaches the
 * change handler progressively — no `hydrateRoot` needed for a single native
 * control, which keeps the client bundle tiny. Switching locale sets a cookie
 * the server reads on the next request (see i18n `detectLocale`) and reloads.
 *
 * The cookie name MUST match what the backend reads. One year, lax, path=/.
 */
const COOKIE_NAME = "tg_locale";

function onChange(event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  const locale = select.value;
  // biome-ignore lint/suspicious/noDocumentCookie: single non-HttpOnly preference cookie; document.cookie has universal support whereas CookieStore is still absent in Safari.
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(locale)};path=/;max-age=31536000;samesite=lax`;
  // Full reload so the server re-renders every string in the chosen locale.
  window.location.reload();
}

for (const root of document.querySelectorAll<HTMLElement>('[data-island="language-switcher"]')) {
  const select = root.querySelector("select");
  select?.addEventListener("change", onChange);
}
