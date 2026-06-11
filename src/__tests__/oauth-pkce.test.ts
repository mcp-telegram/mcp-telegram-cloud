/**
 * PKCE enforcement (security audit 2026-06-11, finding M3).
 *
 * The provider must accept ONLY S256 and reject the `plain` method and empty
 * challenges. With `plain`, the challenge equals the verifier, so a leaked auth
 * code defeats PKCE; an empty challenge means no PKCE at all. `/authorize`
 * rejects these up front (route test), and verifyPKCE is the defense-in-depth
 * backstop exercised here through exchangeCode.
 *
 * Same env-before-dynamic-import pattern as oauth-token-hashing.test.ts.
 */
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://test.invalid";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type { OAuthProvider as OAuthProviderType } from "../oauth.js";

const { Database } = await import("bun:sqlite");
const { OAuthProvider } = await import("../oauth.js");

const REDIRECT = "https://example.test/cb";

function setup(): { oauth: OAuthProviderType; clientId: string } {
  const db = new Database(":memory:");
  const oauth = new OAuthProvider({ issuer: "https://mcp-telegram.com", db });
  const reg = oauth.registerClient({ redirect_uris: [REDIRECT], client_name: "test" });
  return { oauth, clientId: reg.client_id as string };
}

function mintCode(oauth: OAuthProviderType, clientId: string, codeChallenge: string, method: string): string {
  return oauth.createAuthCode({
    clientId,
    userId: "alex",
    redirectUri: REDIRECT,
    codeChallenge,
    codeChallengeMethod: method,
  });
}

describe("PKCE enforcement (verifyPKCE via exchangeCode)", () => {
  it("accepts a correct S256 verifier/challenge pair", () => {
    const { oauth, clientId } = setup();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = mintCode(oauth, clientId, challenge, "S256");
    const pair = oauth.exchangeCode({ code, clientId, codeVerifier: verifier, redirectUri: REDIRECT });
    assert.ok(pair, "valid S256 PKCE must succeed");
  });

  it("rejects the `plain` method even when verifier === challenge", () => {
    const { oauth, clientId } = setup();
    // In a `plain` flow the verifier IS the challenge — the exact attack we refuse.
    const secret = randomBytes(32).toString("base64url");
    const code = mintCode(oauth, clientId, secret, "plain");
    const pair = oauth.exchangeCode({ code, clientId, codeVerifier: secret, redirectUri: REDIRECT });
    assert.equal(pair, null, "`plain` PKCE must be rejected");
  });

  it("rejects an empty challenge with an empty verifier (no-PKCE bypass)", () => {
    const { oauth, clientId } = setup();
    const code = mintCode(oauth, clientId, "", "S256");
    const pair = oauth.exchangeCode({ code, clientId, codeVerifier: "", redirectUri: REDIRECT });
    assert.equal(pair, null, "empty challenge/verifier must not authenticate");
  });

  it("rejects a wrong verifier under S256", () => {
    const { oauth, clientId } = setup();
    const challenge = createHash("sha256").update("right").digest("base64url");
    const code = mintCode(oauth, clientId, challenge, "S256");
    const pair = oauth.exchangeCode({ code, clientId, codeVerifier: "wrong", redirectUri: REDIRECT });
    assert.equal(pair, null);
  });
});
