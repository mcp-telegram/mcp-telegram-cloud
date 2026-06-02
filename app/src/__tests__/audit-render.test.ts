import { describe, expect, it } from "bun:test";
import { type AuditRow, render } from "../pages/audit.js";

const rows: AuditRow[] = [
  {
    id: 1,
    user_id: "overpod",
    tool_name: "telegram-send-message",
    args_summary: "chat=123",
    result: "ok",
    created_at: "2026-06-02 10:00:00",
  },
  {
    id: 2,
    user_id: "overpod",
    tool_name: "telegram-delete-message",
    args_summary: "id=456",
    result: "denied_disabled",
    created_at: "2026-06-02 10:01:00",
  },
];

const base = { username: "overpod", rows };

describe("audit page render (SSR)", () => {
  it("emits a full HTML document", () => {
    const html = render({ ...base, locale: "en" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>");
  });

  it("renders English copy with lang=en dir=ltr", () => {
    const html = render({ ...base, locale: "en" });
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("Activity");
  });

  it("renders Russian copy with lang=ru", () => {
    const html = render({ ...base, locale: "ru" });
    expect(html).toContain('lang="ru"');
  });

  it("sets dir=rtl for Arabic (copy falls back to English until translated)", () => {
    const html = render({ ...base, locale: "ar" });
    expect(html).toContain('dir="rtl"');
  });

  it("always bakes in noindex (functional-only host)", () => {
    expect(render({ ...base, locale: "en" })).toContain('content="noindex, nofollow"');
  });

  it("renders the audit rows", () => {
    const html = render({ ...base, locale: "en" });
    expect(html).toContain("telegram-send-message");
    expect(html).toContain("telegram-delete-message");
  });

  it("renders the empty state when there are no rows", () => {
    const html = render({ ...base, locale: "en", rows: [] });
    expect(html).toContain("No activity yet.");
  });
});
