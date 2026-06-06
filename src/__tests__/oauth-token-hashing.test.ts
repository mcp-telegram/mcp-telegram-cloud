/**
 * At-rest hashing of OAuth secrets (phase 2 of the cloud.db hardening).
 *
 * Verifies that access tokens, refresh tokens, auth codes, and client secrets are stored as
 * `h1:` SHA-256 hashes — never plaintext — while staying transparent to clients (who keep
 * sending the original plaintext, matched via dual-read). Also covers migrateTokenHashes()
 * upgrading legacy plaintext rows and tolerating a mixed (migrated + legacy) table.
 *
 * Same env-before-dynamic-import pattern as oauth-refresh-rotation.test.ts.
 */
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://test.invalid";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import type { Database as DatabaseType } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type { OAuthProvider as OAuthProviderType } from "../oauth.js";

const { Database } = await import("bun:sqlite");
const { OAuthProvider } = await import("../oauth.js");
const { hashToken, isHashedToken } = await import("../crypto.js");

const ISSUER = "https://mcp-telegram.com";

function setup(): { oauth: OAuthProviderType; db: DatabaseType; clientId: string; clientSecret: string } {
  const db = new Database(":memory:");
  const oauth = new OAuthProvider({ issuer: ISSUER, db });
  const reg = oauth.registerClient({ redirect_uris: ["https://example.test/cb"], client_name: "test" });
  return { oauth, db, clientId: reg.client_id as string, clientSecret: reg.client_secret as string };
}

/** Full PKCE auth-code → token-pair, returning the plaintext tokens the client would hold. */
function obtainPair(oauth: OAuthProviderType, clientId: string, userId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = oauth.createAuthCode({
    clientId,
    userId,
    redirectUri: "https://example.test/cb",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  const pair = oauth.exchangeCode({ code, clientId, codeVerifier: verifier, redirectUri: "https://example.test/cb" });
  assert.ok(pair);
  return pair;
}

describe("OAuth at-rest hashing", () => {
  it("registerClient stores client_secret hashed, returns plaintext", () => {
    const { db, clientId, clientSecret } = setup();
    const stored = (
      db.prepare("SELECT client_secret FROM oauth_clients WHERE client_id = ?").get(clientId) as {
        client_secret: string;
      }
    ).client_secret;
    assert.ok(isHashedToken(stored), "client_secret must be stored as an h1: hash");
    assert.notEqual(stored, clientSecret, "plaintext secret must never hit disk");
    assert.equal(stored, hashToken(clientSecret), "stored hash matches hashToken(plaintext)");
  });

  it("access + refresh tokens are stored hashed and validate via plaintext (dual-read)", () => {
    const { oauth, db, clientId } = setup();
    const pair = obtainPair(oauth, clientId, "alex");

    const a = (db.prepare("SELECT access_token FROM oauth_tokens").get() as { access_token: string }).access_token;
    const r = (db.prepare("SELECT refresh_token FROM oauth_refresh_tokens").get() as { refresh_token: string })
      .refresh_token;
    assert.ok(isHashedToken(a) && isHashedToken(r), "both tokens stored as h1: hashes");

    // Client presents the plaintext; validateToken hashes on the way in.
    const v = oauth.validateToken(pair.access_token);
    assert.ok(v && v.userId === "alex", "plaintext access token validates against the stored hash");
  });

  it("auth code is stored hashed and exchanges via plaintext", () => {
    const { oauth, db, clientId } = setup();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = oauth.createAuthCode({
      clientId,
      userId: "bob",
      redirectUri: "https://example.test/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const stored = (db.prepare("SELECT code FROM oauth_codes").get() as { code: string }).code;
    assert.ok(isHashedToken(stored), "code stored hashed");
    const pair = oauth.exchangeCode({ code, clientId, codeVerifier: verifier, redirectUri: "https://example.test/cb" });
    assert.ok(pair, "plaintext code exchanges against the stored hash");
  });

  it("dual-read still honours a legacy plaintext access token (not yet migrated)", () => {
    const { oauth, db, clientId } = setup();
    // Simulate a pre-v2.41 row: plaintext token written directly.
    const legacy = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      legacy,
      clientId,
      "legacy_user",
      Math.floor(Date.now() / 1000) + 3600,
    );
    const v = oauth.validateToken(legacy);
    assert.ok(v && v.userId === "legacy_user", "legacy plaintext token still validates via dual-read");
  });

  it("migrateTokenHashes upgrades legacy plaintext rows across all tables, idempotently", () => {
    const { oauth, db, clientId } = setup();
    // registerClient already hashed the client_secret. Add legacy plaintext rows directly.
    const legacyAccess = randomBytes(32).toString("hex");
    const legacyRefresh = randomBytes(32).toString("hex");
    const legacyCode = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      legacyAccess,
      clientId,
      "u",
      Math.floor(Date.now() / 1000) + 3600,
    );
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, ?, 0, ?)",
    ).run(legacyRefresh, clientId, "u", "chain1");
    db.prepare(
      "INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(legacyCode, clientId, "u", "https://example.test/cb", "x", "S256", Math.floor(Date.now() / 1000) + 600);

    const migrated = oauth.migrateTokenHashes();
    assert.ok(migrated >= 3, `at least the 3 legacy rows migrate (got ${migrated})`);

    // Every secret column is now an h1: hash.
    const access = (
      db.prepare("SELECT access_token FROM oauth_tokens WHERE access_token = ?").get(hashToken(legacyAccess)) as
        | { access_token: string }
        | undefined
    )?.access_token;
    assert.ok(access && isHashedToken(access), "legacy access token now hashed");
    assert.ok(
      isHashedToken(
        (
          db.prepare("SELECT refresh_token FROM oauth_refresh_tokens WHERE chain_id = ?").get("chain1") as {
            refresh_token: string;
          }
        ).refresh_token,
      ),
      "legacy refresh token now hashed",
    );

    // Legacy access token still validates via plaintext after migration.
    const v = oauth.validateToken(legacyAccess);
    assert.ok(v && v.userId === "u", "migrated token still validates against its plaintext");

    // Idempotent: a second sweep migrates nothing.
    assert.equal(oauth.migrateTokenHashes(), 0, "second sweep is a no-op");
  });
});
