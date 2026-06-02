/**
 * Telegram design tokens + base page CSS for the backend React pages.
 *
 * Mirrors the tokens in the backend's `src/styles.ts` (the hono pages use them
 * via hono/css). Duplicated here on purpose — the `app/` bundle must not import
 * backend source. Keep the palette in sync if the backend's changes.
 */
export const tg = {
  secondaryBg: "#EFEFF4",
  cardBg: "#FFFFFF",
  tertiaryBg: "#F4F4F7",
  text: "#000000",
  hint: "#707579",
  link: "#007AFF",
  button: "#007AFF",
  buttonText: "#FFFFFF",
  destructive: "#E53935",
  green: "#31D158",
  outline: "rgba(0, 0, 0, .05)",
  font: 'system-ui, -apple-system, BlinkMacSystemFont, "Roboto", "Helvetica Neue", sans-serif',
} as const;

/** Base document CSS injected into <head> by Layout. Self-contained. */
export const baseCss = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: ${tg.font};
  background: ${tg.secondaryBg};
  color: ${tg.text};
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: ${tg.link}; }
.card {
  background: ${tg.cardBg};
  border-radius: 16px;
  padding: 32px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  margin: 24px auto;
}
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: ${tg.hint}; }
button {
  background: ${tg.button};
  color: ${tg.buttonText};
  border: none;
  border-radius: 12px;
  padding: 12px 24px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
button:hover { opacity: .9; }
button.destructive { background: ${tg.destructive}; }
input, select {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid ${tg.outline};
  border-radius: 8px;
}
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; padding: 10px 12px; background: ${tg.tertiaryBg}; font-size: 12px; text-transform: uppercase; color: ${tg.hint}; }
td { padding: 10px 12px; border-bottom: 1px solid ${tg.outline}; }
.flash { background: ${tg.tertiaryBg}; border-inline-start: 3px solid ${tg.green}; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
.muted { color: ${tg.hint}; }
`;
