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
export const successBlock = css`
  background: ${tg.tertiaryBg};
  border: 1px solid ${tg.link};
  border-radius: 12px;
  padding: 20px;
  margin: 20px 0;
  & h2 { color: ${tg.link}; font-size: 20px; margin-bottom: 8px; }
`;

export const errorBlock = css`
  background: ${tg.tertiaryBg};
  border: 1px solid ${tg.destructive};
  border-radius: 12px;
  padding: 20px;
  margin: 20px 0;
`;

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

// ─── Landing page ────────────────────────────────────────────────────
export const landingReset = `
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: ${tg.font};
    background: ${tg.bg};
    color: ${tg.text};
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; text-decoration: none; }
`;

export const landing = {
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-width: 960px;
    margin: 0 auto;
    padding: 20px 24px;
  `,
  logo: css`
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 17px;
    font-weight: 700;
    & img, & svg { width: 28px; height: 28px; }
  `,
  nav: css`
    display: flex;
    gap: 24px;
    font-size: 15px;
    color: ${tg.hint};
    & a { transition: color .15s; }
    & a:hover { color: ${tg.link}; }
  `,
  hero: css`
    text-align: center;
    padding: 80px 24px 64px;
    max-width: 720px;
    margin: 0 auto;
  `,
  heroTitle: css`
    font-size: 44px;
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: -0.5px;
    margin-bottom: 16px;
    & span { color: ${tg.link}; }
    @media (max-width: 600px) { font-size: 32px; }
  `,
  heroSubtitle: css`
    font-size: 18px;
    line-height: 28px;
    color: ${tg.hint};
    max-width: 520px;
    margin: 0 auto 32px;
  `,
  cta: css`
    display: inline-block;
    padding: 14px 32px;
    border-radius: 12px;
    background: ${tg.button};
    color: ${tg.buttonText};
    font-size: 17px;
    font-weight: 600;
    transition: opacity .15s ease-out;
    &:hover { opacity: 0.85; }
  `,
  ctaSecondary: css`
    display: inline-block;
    padding: 14px 32px;
    border-radius: 12px;
    background: ${tg.tertiaryBg};
    color: ${tg.text};
    font-size: 17px;
    font-weight: 600;
    margin-left: 12px;
    transition: background .15s ease-out;
    &:hover { background: ${tg.secondaryBg}; }
  `,
  section: css`
    max-width: 960px;
    margin: 0 auto;
    padding: 64px 24px;
  `,
  sectionTitle: css`
    text-align: center;
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 12px;
  `,
  sectionSubtitle: css`
    text-align: center;
    font-size: 15px;
    color: ${tg.hint};
    margin-bottom: 48px;
  `,
  featureGrid: css`
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    @media (max-width: 700px) { grid-template-columns: 1fr; }
  `,
  featureCard: css`
    background: ${tg.secondaryBg};
    border-radius: 20px;
    padding: 28px 24px;
    & h3 {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    & p {
      font-size: 15px;
      line-height: 22px;
      color: ${tg.hint};
    }
  `,
  featureIcon: css`
    font-size: 32px;
    margin-bottom: 12px;
  `,
  stepsRow: css`
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    counter-reset: step;
    @media (max-width: 700px) { grid-template-columns: 1fr; }
  `,
  stepCard: css`
    background: ${tg.secondaryBg};
    border-radius: 20px;
    padding: 28px 24px;
    position: relative;
    counter-increment: step;
    &::before {
      content: counter(step);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: ${tg.link};
      color: ${tg.buttonText};
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    & h3 {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    & p {
      font-size: 15px;
      line-height: 22px;
      color: ${tg.hint};
    }
  `,
  pricingGrid: css`
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    @media (max-width: 700px) { grid-template-columns: 1fr; }
  `,
  pricingCard: css`
    background: ${tg.secondaryBg};
    border-radius: 20px;
    padding: 32px 24px;
    text-align: center;
    & h3 {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 4px;
    }
  `,
  pricingHighlight: css`
    background: ${tg.bg};
    border: 2px solid ${tg.link};
    border-radius: 20px;
    padding: 32px 24px;
    text-align: center;
    box-shadow: ${tg.cardShadow};
    & h3 {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 4px;
    }
  `,
  pricingPrice: css`
    font-size: 36px;
    font-weight: 800;
    margin: 16px 0 4px;
    & span { font-size: 15px; font-weight: 400; color: ${tg.hint}; }
  `,
  pricingDesc: css`
    font-size: 13px;
    color: ${tg.hint};
    margin-bottom: 20px;
  `,
  pricingFeatures: css`
    text-align: left;
    font-size: 15px;
    line-height: 28px;
    color: ${tg.text};
    & li {
      list-style: none;
      padding-left: 20px;
      position: relative;
      &::before {
        content: "✓";
        position: absolute;
        left: 0;
        color: ${tg.link};
        font-weight: 700;
      }
    }
  `,
  pricingCta: css`
    display: inline-block;
    margin-top: 20px;
    padding: 10px 24px;
    border-radius: 12px;
    background: ${tg.button};
    color: ${tg.buttonText};
    font-size: 15px;
    font-weight: 600;
    transition: opacity .15s ease-out;
    &:hover { opacity: 0.85; }
  `,
  pricingCtaOutline: css`
    display: inline-block;
    margin-top: 20px;
    padding: 10px 24px;
    border-radius: 12px;
    background: transparent;
    border: 1px solid ${tg.divider};
    color: ${tg.text};
    font-size: 15px;
    font-weight: 600;
    transition: background .15s ease-out;
    &:hover { background: ${tg.tertiaryBg}; }
  `,
  badge: css`
    display: inline-block;
    background: ${tg.link};
    color: ${tg.buttonText};
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 6px;
    margin-bottom: 12px;
  `,
  divider: css`
    border: none;
    border-top: 1px solid ${tg.outline};
    margin: 0;
  `,
  footer: css`
    text-align: center;
    padding: 32px 24px;
    font-size: 13px;
    color: ${tg.secondaryHint};
    & a { color: ${tg.hint}; transition: color .15s; }
    & a:hover { color: ${tg.link}; }
  `,
  toolsGrid: css`
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    @media (max-width: 700px) { grid-template-columns: 1fr; }
  `,
  toolItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    padding: 10px 14px;
    background: ${tg.secondaryBg};
    border-radius: 12px;
    & code {
      font-size: 13px;
      color: ${tg.link};
      font-weight: 600;
    }
  `,
  faqList: css`
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  faqItem: css`
    background: ${tg.secondaryBg};
    border-radius: 16px;
    padding: 24px;
    & h3 {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    & p {
      font-size: 15px;
      line-height: 24px;
      color: ${tg.hint};
    }
  `,
};
