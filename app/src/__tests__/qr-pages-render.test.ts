import { describe, expect, it } from "bun:test";
import { render as renderAddAccount } from "../pages/add-account.js";
import { render as renderAuthorize } from "../pages/authorize.js";
import { render as renderLogin } from "../pages/login.js";

describe("login page render (SSR)", () => {
  it("emits a doc with noindex, userId input, and the username-templated SSE URL", () => {
    const html = renderLogin({ locale: "en" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('id="userId"');
    expect(html).toContain("data-sse-url-template");
  });

  it("localizes (ja) and is not auto-start (user types username first)", () => {
    const html = renderLogin({ locale: "ja" });
    expect(html).toContain('lang="ja"');
    expect(html).not.toContain('data-auto="1"');
  });
});

describe("add-account page render (SSR)", () => {
  it("wires the token into the SSE URL and shows the label", () => {
    const html = renderAddAccount({ locale: "fr", token: "tok123", label: "work" });
    expect(html).toContain("/accounts/add/tok123/qr");
    expect(html).toContain("work");
    expect(html).toContain('lang="fr"');
  });

  it("omits label when null", () => {
    const html = renderAddAccount({ locale: "en", token: "t", label: null });
    expect(html).toContain("/accounts/add/t/qr");
  });
});

describe("authorize page render (SSR) — critical OAuth path", () => {
  const base = {
    clientId: "claude",
    clientName: "Claude",
    redirectUri: "https://claude.ai/cb",
    state: "xyz",
    codeChallenge: "chal123",
    codeChallengeMethod: "S256",
  };

  it("auto-starts and carries every OAuth param in the SSE URL", () => {
    const html = renderAuthorize({ ...base, locale: "es" }).replace(/&amp;/g, "&");
    expect(html).toContain('data-auto="1"');
    expect(html).toContain("/oauth/authorize/qr/cookie");
    expect(html).toContain("client_id=claude");
    expect(html).toContain("redirect_uri=https");
    expect(html).toContain("state=xyz");
    expect(html).toContain("code_challenge=chal123");
    expect(html).toContain("code_challenge_method=S256");
  });

  it("shows the client name and localizes", () => {
    const html = renderAuthorize({ ...base, locale: "es" });
    expect(html).toContain("Claude");
    expect(html).toContain('lang="es"');
    expect(html).toContain('content="noindex, nofollow"');
  });
});
