import { describe, expect, it } from "bun:test";
import { createTranslator, detectLocale, getMessages, isRtl, LOCALE_CODES } from "../i18n/index.js";

describe("getMessages", () => {
  it("returns the locale's catalog when registered", () => {
    expect(getMessages("ru").login.title).toBe("Подключите свой аккаунт Telegram");
  });

  it("falls back to English for an unregistered (but listed) locale", () => {
    // `ja` is a supported code but has no catalog yet → English fallback.
    expect(getMessages("ja").login.title).toBe(getMessages("en").login.title);
  });

  it("falls back to English for a completely unknown code", () => {
    expect(getMessages("klingon").login.title).toBe(getMessages("en").login.title);
  });
});

describe("createTranslator", () => {
  it("resolves a dotted key against the catalog", () => {
    const t = createTranslator(getMessages("en"));
    expect(t("login.startButton")).toBe("Start QR Login");
    expect(t("settings.save")).toBe("Save");
  });

  it("translates per locale", () => {
    const t = createTranslator(getMessages("ru"));
    expect(t("settings.save")).toBe("Сохранить");
  });
});

describe("detectLocale", () => {
  it("prefers a valid cookie over Accept-Language", () => {
    expect(detectLocale("de,en;q=0.8", "ru")).toBe("ru");
  });

  it("ignores an unsupported cookie and uses Accept-Language", () => {
    expect(detectLocale("de,en;q=0.8", "klingon")).toBe("de");
  });

  it("respects q-weights in Accept-Language", () => {
    // en has higher q than fr → en wins despite fr being first.
    expect(detectLocale("fr;q=0.5,en;q=0.9", undefined)).toBe("en");
  });

  it("falls back from a regional tag to its base language", () => {
    expect(detectLocale("de-AT", undefined)).toBe("de");
  });

  it("matches case-insensitively", () => {
    expect(detectLocale("PT-br", undefined)).toBe("pt-BR");
  });

  it("defaults to English when nothing matches", () => {
    expect(detectLocale("xx,yy", undefined)).toBe("en");
    expect(detectLocale(undefined, undefined)).toBe("en");
  });
});

describe("locale registry", () => {
  it("lists 20 locales", () => {
    expect(LOCALE_CODES.length).toBe(20);
  });

  it("flags Arabic as RTL and English as LTR", () => {
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("en")).toBe(false);
  });
});
