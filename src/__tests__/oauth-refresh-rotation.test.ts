import type { Database as DatabaseType } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type { OAuthProvider as OAuthProviderType } from "../oauth.js";

// `oauth.ts` → `logger.ts` → `config.ts` requires several env vars. Set defaults BEFORE
// any module that pulls config is imported, then use dynamic `await import()`. Type-only
// imports above are erased at runtime so they don't trigger the eager `config.ts` load.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://test.invalid";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

const { Database } = await import("bun:sqlite");
const { OAuthProvider } = await import("../oauth.js");

const ISSUER = "https://mcp-telegram.com";

function freshDb(): DatabaseType {
  return new Database(":memory:");
}

function setupProviderWithClient(): {
  oauth: OAuthProviderType;
  db: DatabaseType;
  clientId: string;
} {
  const db = freshDb();
  const oauth = new OAuthProvider({ issuer: ISSUER, db });
  const reg = oauth.registerClient({ redirect_uris: ["https://example.test/cb"], client_name: "test" });
  return { oauth, db, clientId: reg.client_id as string };
}

/** Drive a full auth-code → access+refresh exchange with PKCE so we exercise the public path. */
function obtainInitialPair(
  oauth: OAuthProviderType,
  clientId: string,
  userId: string,
): { access_token: string; refresh_token: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = oauth.createAuthCode({
    clientId,
    userId,
    redirectUri: "https://example.test/cb",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  const result = oauth.exchangeCode({
    code,
    clientId,
    codeVerifier: verifier,
    redirectUri: "https://example.test/cb",
  });
  assert.ok(result, "exchangeCode must succeed");
  return result;
}

describe("OAuthProvider — refresh rotation + replay detection (v2.23.0)", () => {
  it("issues never-expiring refresh tokens (expires_at = 0) on auth-code exchange", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    const pair = obtainInitialPair(oauth, clientId, "user_a");

    const row = db
      .prepare("SELECT expires_at, chain_id, revoked, replaced_by FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(pair.refresh_token) as { expires_at: number; chain_id: string; revoked: number; replaced_by: string | null };

    assert.equal(row.expires_at, 0, "refresh token must have expires_at = 0 (never expires)");
    assert.ok(row.chain_id, "chain_id must be set on initial issue");
    assert.equal(row.revoked, 0);
    assert.equal(row.replaced_by, null);
  });

  it("rotates the refresh token: old becomes revoked + replaced_by, new lives in same chain", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    const initial = obtainInitialPair(oauth, clientId, "user_b");
    const initialChain = (
      db.prepare("SELECT chain_id FROM oauth_refresh_tokens WHERE refresh_token = ?").get(initial.refresh_token) as {
        chain_id: string;
      }
    ).chain_id;

    const refreshed = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId });
    assert.ok(refreshed, "refresh must succeed on first use");
    assert.notEqual(refreshed.refresh_token, initial.refresh_token);
    assert.notEqual(refreshed.access_token, initial.access_token);

    const oldRow = db
      .prepare("SELECT revoked, replaced_by FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(initial.refresh_token) as { revoked: number; replaced_by: string | null };
    assert.equal(oldRow.revoked, 1, "old refresh token must be marked revoked");
    assert.equal(oldRow.replaced_by, refreshed.refresh_token, "old token must point at its successor");

    const newRow = db
      .prepare("SELECT chain_id, expires_at, revoked FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(refreshed.refresh_token) as { chain_id: string; expires_at: number; revoked: number };
    assert.equal(newRow.chain_id, initialChain, "rotated token stays in the same chain");
    assert.equal(newRow.expires_at, 0, "rotated token also never expires");
    assert.equal(newRow.revoked, 0);
  });

  it("detects replay: reusing an already-rotated token revokes the entire chain + access tokens", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    const initial = obtainInitialPair(oauth, clientId, "user_c");
    const refreshed = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId });
    assert.ok(refreshed);

    // Push revoked_at outside the concurrent-retry window so we hit the real replay path,
    // not the benign-retry shortcut.
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE refresh_token = ?").run(
      Math.floor(Date.now() / 1000) - 60,
      initial.refresh_token,
    );

    // Attacker (or buggy client) replays the original refresh token.
    const replay = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId });
    assert.equal(replay, null, "replay must be rejected");

    // Both refresh tokens in the chain are now revoked.
    const refreshRows = db
      .prepare("SELECT refresh_token, revoked FROM oauth_refresh_tokens WHERE user_id = ?")
      .all("user_c") as Array<{ refresh_token: string; revoked: number }>;
    for (const row of refreshRows) {
      assert.equal(row.revoked, 1, `every refresh token in the chain must be revoked: ${row.refresh_token}`);
    }

    // Active access tokens for (user_c, clientId) are wiped — forces a fresh auth-code flow.
    const accessRows = db.prepare("SELECT access_token FROM oauth_tokens WHERE user_id = ?").all("user_c");
    assert.equal(accessRows.length, 0, "all access tokens must be cleared after replay revoke");

    // The rotated (still-non-revoked-before-replay) token now also fails.
    const followUp = oauth.refreshAccessToken({ refreshToken: refreshed.refresh_token, clientId });
    assert.equal(followUp, null, "the legitimate rotated token is also revoked after replay");
  });

  it("rejects refresh tokens used with a wrong client_id", () => {
    const { oauth, clientId } = setupProviderWithClient();
    const initial = obtainInitialPair(oauth, clientId, "user_d");
    const result = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId: "wrong" });
    assert.equal(result, null);
  });

  it("auto-upgrades pre-v2.23.0 refresh tokens (finite expires_at, no chain_id) on first refresh", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    // Simulate a token row written by the previous code: 30-day expiry, empty chain_id.
    const legacyRefresh = "legacy_refresh_token_value";
    const userId = "user_e";
    const accessToken = "legacy_access_token_value";
    const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 1 day in the future
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      accessToken,
      clientId,
      userId,
      expiresAt,
    );
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, ?, ?, ?)",
    ).run(legacyRefresh, clientId, userId, expiresAt, "");

    const refreshed = oauth.refreshAccessToken({ refreshToken: legacyRefresh, clientId });
    assert.ok(refreshed, "legacy token must rotate successfully");

    const newRow = db
      .prepare("SELECT expires_at, chain_id FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(refreshed.refresh_token) as { expires_at: number; chain_id: string };
    assert.equal(newRow.expires_at, 0, "rotated legacy token is upgraded to never-expires");
    assert.ok(newRow.chain_id, "a fresh chain_id is allocated for legacy tokens that had none");
  });

  it("rejects pre-v2.23.0 refresh tokens whose finite expires_at has already passed", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    const legacyRefresh = "expired_legacy_token";
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, ?, ?, ?)",
    ).run(legacyRefresh, clientId, "user_f", Math.floor(Date.now() / 1000) - 60, "");

    const result = oauth.refreshAccessToken({ refreshToken: legacyRefresh, clientId });
    assert.equal(result, null, "expired legacy refresh tokens must still be rejected");
  });

  it("cleanup() leaves never-expiring (expires_at=0) refresh tokens untouched", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    const initial = obtainInitialPair(oauth, clientId, "user_g");

    // Insert a stale legacy row that *should* be cleaned up.
    const staleLegacy = "stale_legacy_token";
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, ?, ?, ?)",
    ).run(staleLegacy, clientId, "user_g", Math.floor(Date.now() / 1000) - 3600, "");

    oauth.cleanup();

    const survivors = db
      .prepare("SELECT refresh_token FROM oauth_refresh_tokens WHERE user_id = ?")
      .all("user_g") as Array<{ refresh_token: string }>;
    const tokens = survivors.map((r) => r.refresh_token);
    assert.ok(tokens.includes(initial.refresh_token), "never-expiring token must survive cleanup");
    assert.ok(!tokens.includes(staleLegacy), "stale legacy token must be removed by cleanup");
  });

  it("revokeAllUserTokens still wipes both access and refresh tables for the user", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    obtainInitialPair(oauth, clientId, "user_h");

    const removed = oauth.revokeAllUserTokens("user_h");
    assert.ok(removed >= 2);
    const remaining = db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM oauth_tokens WHERE user_id = ?) AS a, (SELECT COUNT(*) FROM oauth_refresh_tokens WHERE user_id = ?) AS r",
      )
      .get("user_h", "user_h") as { a: number; r: number };
    assert.equal(remaining.a, 0);
    assert.equal(remaining.r, 0);
  });

  it("replays through a chain length >2 revoke every generation in the chain", () => {
    // Rotate 5 times, then replay the 3rd-generation token. All 6 tokens (5 generations + the
    // still-active 6th leaf) must end up revoked.
    const { oauth, db, clientId } = setupProviderWithClient();
    const initial = obtainInitialPair(oauth, clientId, "user_chain");

    const generations: string[] = [initial.refresh_token];
    let current = initial.refresh_token;
    for (let i = 0; i < 5; i++) {
      const next = oauth.refreshAccessToken({ refreshToken: current, clientId });
      assert.ok(next, `generation ${i + 1} must rotate cleanly`);
      generations.push(next.refresh_token);
      current = next.refresh_token;
    }
    assert.equal(generations.length, 6, "5 rotations should produce a 6-token chain");

    // Sanity: all 6 tokens share one chain_id.
    const chainIds = db
      .prepare("SELECT chain_id FROM oauth_refresh_tokens WHERE user_id = ? ORDER BY rowid")
      .all("user_chain") as Array<{ chain_id: string }>;
    const distinctChains = new Set(chainIds.map((r) => r.chain_id));
    assert.equal(distinctChains.size, 1, "the whole chain must share one chain_id");

    // Replay the 3rd-generation token (interior, already rotated long ago).
    // Forge the timestamp to be outside the concurrent-retry window so we hit the replay path.
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE refresh_token = ?").run(
      Math.floor(Date.now() / 1000) - 60,
      generations[2],
    );
    const replay = oauth.refreshAccessToken({ refreshToken: generations[2], clientId });
    assert.equal(replay, null, "interior-chain replay must be rejected");

    // Every generation, including the 6th still-active leaf, is now revoked.
    const finalState = db
      .prepare("SELECT refresh_token, revoked FROM oauth_refresh_tokens WHERE user_id = ?")
      .all("user_chain") as Array<{ refresh_token: string; revoked: number }>;
    assert.equal(finalState.length, 6);
    for (const row of finalState) {
      assert.equal(row.revoked, 1, `every chain entry must be revoked: ${row.refresh_token}`);
    }
  });

  it("replay of a legacy refresh token (auto-upgraded) revokes the entire upgraded chain", () => {
    // Tied to MEDIUM-4 from review: legacy rows had chain_id=''. When the user successfully
    // refreshes, both the new row and the legacy row must be stamped with the new chain_id so
    // a later replay of the legacy token lands in revokeChain() and finds every generation.
    const { oauth, db, clientId } = setupProviderWithClient();
    const legacyRefresh = "legacy_attacker_can_capture_this";
    const userId = "user_legacy_replay";
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id) VALUES (?, ?, ?, ?, ?)",
    ).run(legacyRefresh, clientId, userId, Math.floor(Date.now() / 1000) + 86400, "");

    const upgraded = oauth.refreshAccessToken({ refreshToken: legacyRefresh, clientId });
    assert.ok(upgraded, "legacy token must rotate cleanly");

    const upgradedChain = (
      db.prepare("SELECT chain_id FROM oauth_refresh_tokens WHERE refresh_token = ?").get(upgraded.refresh_token) as {
        chain_id: string;
      }
    ).chain_id;
    assert.ok(upgradedChain, "rotated leaf must have a chain_id");

    const legacyAfter = db
      .prepare("SELECT chain_id FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(legacyRefresh) as { chain_id: string };
    assert.equal(legacyAfter.chain_id, upgradedChain, "legacy row must be stamped with the upgraded chain_id");

    // Push the revoked_at outside the concurrent-retry window, then replay.
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE refresh_token = ?").run(
      Math.floor(Date.now() / 1000) - 60,
      legacyRefresh,
    );
    const replay = oauth.refreshAccessToken({ refreshToken: legacyRefresh, clientId });
    assert.equal(replay, null);

    const upgradedRow = db
      .prepare("SELECT revoked FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(upgraded.refresh_token) as { revoked: number };
    assert.equal(upgradedRow.revoked, 1, "the upgraded chain leaf must be revoked by replay of the legacy token");
  });

  it("treats a refresh-token reuse within the concurrent-retry window as a benign retry (no chain revoke)", () => {
    // Network-truncated A's response → client retries with the same refresh_token within
    // seconds. Returning null without revoking the chain prevents false-positive lockouts.
    const { oauth, db, clientId } = setupProviderWithClient();
    const initial = obtainInitialPair(oauth, clientId, "user_concurrent");

    const first = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId });
    assert.ok(first, "first refresh must succeed");

    // The default revoked_at stamp from the first refresh is "now", which is inside the 10s
    // window. Replaying immediately should NOT trigger revokeChain.
    const concurrent = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId });
    assert.equal(concurrent, null, "concurrent retry returns null");

    // The freshly issued chain leaf must remain valid (not revoked).
    const leafRow = db
      .prepare("SELECT revoked FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(first.refresh_token) as { revoked: number };
    assert.equal(leafRow.revoked, 0, "live leaf must NOT be revoked by a concurrent retry");

    // The user's access tokens are also untouched.
    const accessCount = (
      db.prepare("SELECT COUNT(*) AS c FROM oauth_tokens WHERE user_id = ?").get("user_concurrent") as { c: number }
    ).c;
    assert.ok(accessCount >= 1, "access tokens must survive a concurrent retry");

    // After we age the revoked_at past the window, replay does revoke the chain.
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE refresh_token = ?").run(
      Math.floor(Date.now() / 1000) - 60,
      initial.refresh_token,
    );
    const lateReplay = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId });
    assert.equal(lateReplay, null);
    const leafAfter = db
      .prepare("SELECT revoked FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get(first.refresh_token) as { revoked: number };
    assert.equal(leafAfter.revoked, 1, "post-window replay must revoke the live leaf");
  });

  it("cleanup() preserves revoked never-expiring rows so replay state is not lost", () => {
    const { oauth, db, clientId } = setupProviderWithClient();
    const initial = obtainInitialPair(oauth, clientId, "user_cleanup_revoked");
    const refreshed = oauth.refreshAccessToken({ refreshToken: initial.refresh_token, clientId });
    assert.ok(refreshed);

    oauth.cleanup();

    const surviving = db
      .prepare("SELECT refresh_token, revoked FROM oauth_refresh_tokens WHERE user_id = ?")
      .all("user_cleanup_revoked") as Array<{ refresh_token: string; revoked: number }>;
    const tokens = surviving.map((r) => r.refresh_token);
    assert.ok(tokens.includes(initial.refresh_token), "revoked but never-expiring row must survive cleanup");
    assert.ok(tokens.includes(refreshed.refresh_token), "live leaf must survive cleanup");
  });

  it("schema migration is idempotent: constructing OAuthProvider twice on the same DB does not throw", () => {
    const db = freshDb();
    new OAuthProvider({ issuer: ISSUER, db });
    // Second construction must not throw on ALTER TABLE — the precheck uses PRAGMA table_info.
    new OAuthProvider({ issuer: ISSUER, db });

    // Verify expected columns exist exactly once each.
    const cols = db.prepare("PRAGMA table_info(oauth_refresh_tokens)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const required of [
      "refresh_token",
      "client_id",
      "user_id",
      "expires_at",
      "chain_id",
      "revoked",
      "replaced_by",
      "revoked_at",
    ]) {
      assert.equal(names.filter((n) => n === required).length, 1, `column ${required} must be present exactly once`);
    }
  });

  it("revokeChain fallback flips revoked=0→1 on a stranded empty-chain row by primary key", () => {
    // A stranded row: chain_id = '', and somehow its `replaced_by` got set without revoked
    // also being set (e.g. partial manual DB edit). On replay the handler enters revokeChain
    // with chainId='' and must rely on the fallback `WHERE refresh_token = ?` UPDATE to flip
    // the row to revoked = 1, otherwise the same token could be replayed forever.
    //
    // We use replaced_by=non-NULL to enter the replay branch while leaving revoked=0 so the
    // fallback UPDATE actually has work to do (and so we can prove it ran).
    const { oauth, db, clientId } = setupProviderWithClient();
    const stranded = "stranded_legacy_token";
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at, chain_id, revoked, replaced_by, revoked_at) VALUES (?, ?, ?, ?, '', 0, ?, ?)",
    ).run(
      stranded,
      clientId,
      "user_stranded",
      0,
      "synthetic_successor_never_existed",
      Math.floor(Date.now() / 1000) - 60, // outside concurrent-retry window → real replay path
    );
    // Insert a synthetic access token for the user under this client so we can also verify
    // the access-token wipe runs even when chain_id is empty.
    db.prepare("INSERT INTO oauth_tokens (access_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
      "synthetic_access",
      clientId,
      "user_stranded",
      Math.floor(Date.now() / 1000) + 3600,
    );

    const result = oauth.refreshAccessToken({ refreshToken: stranded, clientId });
    assert.equal(result, null);

    const after = db.prepare("SELECT revoked FROM oauth_refresh_tokens WHERE refresh_token = ?").get(stranded) as {
      revoked: number;
    };
    assert.equal(after.revoked, 1, "stranded row must be flipped to revoked=1 by the fallback");

    const accessCount = (
      db.prepare("SELECT COUNT(*) AS c FROM oauth_tokens WHERE user_id = ?").get("user_stranded") as { c: number }
    ).c;
    assert.equal(accessCount, 0, "access tokens for the stranded row's user must be wiped");
  });

  it("schema migration adapts an existing v2.22 schema (no rotation columns) without data loss", () => {
    // Build a v2.22-shaped DB directly, insert a legacy row, then mount OAuthProvider on top of it.
    const db = freshDb();
    db.exec(`
      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        redirect_uris TEXT NOT NULL,
        client_name TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE oauth_tokens (
        access_token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE oauth_refresh_tokens (
        refresh_token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)",
    ).run("legacy_pre_migration", "client_x", "user_pre", Math.floor(Date.now() / 1000) + 86400);

    new OAuthProvider({ issuer: ISSUER, db });

    // Existing row preserved + new columns back-filled with defaults.
    const row = db
      .prepare("SELECT chain_id, revoked, replaced_by, revoked_at FROM oauth_refresh_tokens WHERE refresh_token = ?")
      .get("legacy_pre_migration") as {
      chain_id: string;
      revoked: number;
      replaced_by: string | null;
      revoked_at: number;
    };
    assert.equal(row.chain_id, "");
    assert.equal(row.revoked, 0);
    assert.equal(row.replaced_by, null);
    assert.equal(row.revoked_at, 0);
  });
});
