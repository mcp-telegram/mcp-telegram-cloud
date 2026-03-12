import { css, keyframes } from "hono/css";

const spin = keyframes`
  to { transform: rotate(360deg); }
`;

// ─── Base ────────────────────────────────────────────────────────────
export const globalStyles = css`
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
`;

// ─── Card ────────────────────────────────────────────────────────────
export const card = css`
  background: #1e293b;
  border-radius: 16px;
  padding: 40px;
  max-width: 420px;
  width: 100%;
  box-shadow: 0 25px 50px rgba(0,0,0,.3);
  text-align: center;
`;

export const title = css`
  font-size: 24px;
  margin-bottom: 8px;
`;

export const subtitle = css`
  color: #94a3b8;
  margin-bottom: 24px;
  font-size: 14px;
`;

// ─── QR ──────────────────────────────────────────────────────────────
export const qrContainer = css`
  background: white;
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
  color: #94a3b8;
  font-size: 14px;
  margin: 16px 0;
  min-height: 20px;
`;

// ─── Info blocks ─────────────────────────────────────────────────────
export const clientBlock = css`
  background: #334155;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 24px;
  font-size: 14px;
`;

export const step = css`
  background: #334155;
  border-radius: 8px;
  padding: 12px;
  margin: 8px 0;
  font-size: 13px;
  text-align: left;
  & strong { color: #60a5fa; }
`;

export const scope = css`
  color: #94a3b8;
  font-size: 13px;
  margin-top: 16px;
`;

// ─── Status blocks ───────────────────────────────────────────────────
export const successBlock = css`
  background: #065f46;
  border-radius: 12px;
  padding: 20px;
  margin: 20px 0;
  & h2 { color: #34d399; font-size: 20px; margin-bottom: 8px; }
`;

export const errorBlock = css`
  background: #7f1d1d;
  border-radius: 12px;
  padding: 20px;
  margin: 20px 0;
`;

export const errorInline = css`
  background: #7f1d1d;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
  font-size: 14px;
`;

// ─── Spinner ─────────────────────────────────────────────────────────
export const spinner = css`
  display: inline-block;
  width: 24px;
  height: 24px;
  border: 3px solid #475569;
  border-top-color: #3b82f6;
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
  font-size: 14px;
  margin-bottom: 6px;
  color: #cbd5e1;
  text-align: left;
`;

export const input = css`
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #475569;
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 16px;
  margin-bottom: 16px;
  outline: none;
  &:focus { border-color: #3b82f6; }
`;

export const button = css`
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: 8px;
  background: #3b82f6;
  color: white;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: background .2s;
  &:hover { background: #2563eb; }
  &:disabled { background: #475569; cursor: not-allowed; }
`;
