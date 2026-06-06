import { css, keyframes } from "hono/css";

const spin = keyframes`
  to { transform: rotate(360deg); }
`;

// ─── Telegram UI Design Tokens (light theme) ────────────────────────
// Source: https://github.com/telegram-mini-apps-dev/TelegramUI
export const tg = {
  bg: "#FFFFFF",
  secondaryBg: "#EFEFF4",
  sectionBg: "#FFFFFF",
  cardBg: "#FFFFFF",
  tertiaryBg: "#F4F4F7",
  quartenaryBg: "#F6F6FA",
  text: "#000000",
  hint: "#707579",
  secondaryHint: "#A2ACB0",
  link: "#007AFF",
  button: "#007AFF",
  buttonText: "#FFFFFF",
  destructive: "#E53935",
  green: "#31D158",
  divider: "rgba(0, 0, 0, .15)",
  outline: "rgba(0, 0, 0, .05)",
  shadow: "0 1px 2px 0 rgba(0, 0, 0, .10)",
  cardShadow: "0 32px 64px 0 rgba(0, 0, 0, .04), 0 0 2px 1px rgba(0, 0, 0, .02)",
  font: 'system-ui, -apple-system, BlinkMacSystemFont, "Roboto", "Apple Color Emoji", "Helvetica Neue", sans-serif',
} as const;

// ─── Global reset (raw CSS string for <style> tag) ──────────────────
export const globalReset = `
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: ${tg.font};
    background: ${tg.secondaryBg};
    color: ${tg.text};
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
  }
`;

// ─── Card ────────────────────────────────────────────────────────────
export const card = css`
  background: ${tg.bg};
  border-radius: 20px;
  padding: 40px;
  max-width: 420px;
  width: 100%;
  box-shadow: ${tg.cardShadow};
  text-align: center;
`;

export const title = css`
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
`;

export const subtitle = css`
  color: ${tg.hint};
  margin-bottom: 24px;
  font-size: 15px;
  line-height: 22px;
`;

// ─── QR ──────────────────────────────────────────────────────────────
export const qrContainer = css`
  background: ${tg.bg};
  border: 1px solid ${tg.divider};
  border-radius: 12px;
  padding: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 20px 0;
  min-height: 288px;
  min-width: 288px;
  & img { width: 256px; height: 256px; }
`;

export const status = css`
  color: ${tg.hint};
  font-size: 15px;
  margin: 16px 0;
  min-height: 20px;
`;

// ─── Info blocks ─────────────────────────────────────────────────────
export const clientBlock = css`
  background: ${tg.tertiaryBg};
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 24px;
  font-size: 15px;
  line-height: 22px;
`;

export const step = css`
  background: ${tg.tertiaryBg};
  border-radius: 12px;
  padding: 12px;
  margin: 8px 0;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  & strong { color: ${tg.link}; }
`;

export const scope = css`
  color: ${tg.secondaryHint};
  font-size: 13px;
  line-height: 20px;
  margin-top: 16px;
`;

// ─── Status blocks ───────────────────────────────────────────────────
export const errorInline = css`
  background: ${tg.tertiaryBg};
  border: 1px solid ${tg.destructive};
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 16px;
  font-size: 15px;
`;

// ─── Spinner ─────────────────────────────────────────────────────────
export const spinner = css`
  display: inline-block;
  width: 24px;
  height: 24px;
  border: 3px solid ${tg.divider};
  border-top-color: ${tg.link};
  border-radius: 50%;
  animation: ${spin} 0.8s linear infinite;
`;

// ─── Toggle visibility (JS-driven) ──────────────────────────────────
export const hidden = css`
  display: none;
`;

// ─── Form elements (login page) ──────────────────────────────────────
export const label = css`
  display: block;
  font-size: 15px;
  margin-bottom: 6px;
  color: ${tg.hint};
  text-align: left;
`;

export const input = css`
  width: 100%;
  padding: 10px 14px;
  border: 1px solid ${tg.divider};
  border-radius: 12px;
  background: ${tg.bg};
  color: ${tg.text};
  font-size: 17px;
  line-height: 26px;
  margin-bottom: 16px;
  outline: none;
  transition: border-color .15s ease-out;
  &:focus { border-color: ${tg.link}; }
`;

export const button = css`
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: 12px;
  background: ${tg.button};
  color: ${tg.buttonText};
  font-size: 17px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity .15s ease-out;
  &:hover { opacity: 0.85; }
  &:disabled { background: ${tg.tertiaryBg}; color: ${tg.secondaryHint}; cursor: not-allowed; }
`;
