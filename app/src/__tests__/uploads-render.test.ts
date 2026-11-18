import { describe, expect, it } from "bun:test";
import { render, type UploadRow } from "../pages/uploads.js";

const base = {
  username: "overpod",
  fileMaxBytes: 52_428_800,
  ttlSeconds: 3600,
  pendingCount: 3,
  pendingLimit: 20,
};

const row: UploadRow = {
  id: "ab12cd",
  mime: "image/png",
  size: 2048,
  original_name: "pic.png",
  expires_at: "2026-06-03",
};

describe("uploads page render (SSR)", () => {
  it("emits a full HTML document with noindex", () => {
    const html = render({ ...base, locale: "en", rows: [] });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('content="noindex, nofollow"');
  });

  it("shows pending uploads against the per-account limit, not a byte quota", () => {
    const html = render({ ...base, locale: "ru", rows: [] });
    expect(html).toContain("Квота: 3 / 20 в ожидании");
    expect(html).toContain('style="width:15%"');
  });

  it("renders the empty state with no rows", () => {
    const html = render({ ...base, locale: "en", rows: [] });
    expect(html).toContain("No pending uploads");
  });

  it("renders a row with its id and a copy button", () => {
    const html = render({ ...base, locale: "en", rows: [row] });
    expect(html).toContain("ab12cd");
    expect(html).toContain('data-copy-id="ab12cd"');
  });

  it("exposes localized island strings via data-msg-* attributes", () => {
    const html = render({ ...base, locale: "ru", rows: [] });
    expect(html).toContain("data-msg-uploading");
    expect(html).toContain('lang="ru"');
  });

  it("sets dir=rtl for Arabic", () => {
    expect(render({ ...base, locale: "ar", rows: [] })).toContain('dir="rtl"');
  });
});
