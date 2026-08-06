/** Applies the stored theme before first paint.
 *
 * Without this the page would render with the CSS default (light, or the OS
 * preference) and only flip once React hydrates — a visible flash for anyone
 * whose saved choice differs from the media query. Runs as a blocking inline
 * script in <head>, so it is deliberately tiny and dependency-free.
 *
 * Only an explicit stored choice sets the attribute; absent one we leave the
 * DOM alone and let `prefers-color-scheme` in globals.css decide. */

export const THEME_STORAGE_KEY = "mcp-tg-theme";

const script = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t}}catch(e){}})()`;

export function ThemeScript() {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: static string, no interpolation of user input.
  return <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: script }} />;
}
