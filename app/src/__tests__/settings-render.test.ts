import { describe, expect, it } from "bun:test";
import { render } from "../pages/settings.js";

const base = { username: "overpod", enabled: false, todayCount: 3, dailyLimit: 0 };

describe("settings page render (SSR)", () => {
  it("emits a full HTML document", () => {
    const html = render({ ...base, locale: "en" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>");
  });

  it("renders English copy with lang=en dir=ltr", () => {
    const html = render({ ...base, locale: "en" });
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("Settings");
  });

  it("renders Russian copy with lang=ru", () => {
    const html = render({ ...base, locale: "ru" });
    expect(html).toContain('lang="ru"');
    expect(html).toContain("Настройки");
  });

  it("sets dir=rtl for Arabic (copy falls back to English until translated)", () => {
    const html = render({ ...base, locale: "ar" });
    expect(html).toContain('dir="rtl"');
  });

  it("always bakes in noindex (functional-only host)", () => {
    expect(render({ ...base, locale: "en" })).toContain('content="noindex, nofollow"');
  });

  it("shows the account username", () => {
    expect(render({ ...base, locale: "en", username: "alice" })).toContain("@alice");
  });
});
