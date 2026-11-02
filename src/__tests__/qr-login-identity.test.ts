/**
 * Session-overwrite hole (found 2026-09-21).
 *
 * `/login/qr?userId=<anything>` passed that string straight to
 * `saveSessionString`, and `user_sessions` upserts with
 * `ON CONFLICT(user_id) DO UPDATE`. So: call `/login/qr?userId=<victim handle>`,
 * scan the QR with YOUR OWN phone, and the victim's stored session row is
 * replaced by yours — after which the victim's still-valid OAuth tokens drive
 * the attacker's Telegram account. The OAuth twin of this flow
 * (`handleOAuthQrLogin`) always derived the id from `getMe()`; only this one
 * trusted the query parameter, and that asymmetry was the bug.
 *
 * Two layers, because the behavioural part cannot be reached without GramJS:
 *   1. the identity rule itself (`SessionManager.resolveAccountKey`, driven in
 *      account-key-ownership.test.ts);
 *   2. a SOURCE guard that the persistence calls inside `handleQrLogin` use the
 *      derived id and never the request-supplied one. A future refactor that
 *      "simplifies" by passing `requestedUserId` back in fails here.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Body of a top-level `export ... function <name>(` up to the next top-level `}`. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — the guard must be retargeted, not deleted`);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("handleQrLogin persists under the scanned identity", () => {
  const source = readFileSync(join(SRC, "qr-login.ts"), "utf8");
  const body = functionBody(source, "handleQrLogin");

  it("derives the storage key from the scanned account", () => {
    assert.match(
      body,
      /const userId = await sessions\.resolveAccountKey\(me\)/,
      "the storage key must come from the scanned account (getMe), resolved against row ownership",
    );
  });

  it("never writes a session under the request-supplied id", () => {
    assert.ok(
      !/saveSessionString\(\s*requestedUserId/.test(body),
      "saveSessionString must not be called with the caller-supplied id",
    );
    assert.ok(
      !/adoptSession\(\s*requestedUserId/.test(body),
      "adoptSession must not be called with the caller-supplied id",
    );
  });

  it("never answers 'connected' for the request-supplied id without a scan", () => {
    // Since 2.61 a `connected` event carries a browser-session ticket, so the old
    // "already connected" shortcut would have signed anyone in as whoever they
    // typed. The only identity the page may receive comes from the scan.
    assert.ok(!/getOrCreateSession\(\s*requestedUserId/.test(body), "no session lookup by the typed id");
    assert.match(body, /createBrowserHandoff\(userId\)/, "the ticket is minted for the scanned account");
    assert.ok(!/createBrowserHandoff\(\s*requestedUserId/.test(body), "never for the typed id");
  });

  it("guard is not vacuous — it fails on the pre-fix shape", () => {
    const preFix = body
      .replace(/const userId = await sessions\.resolveAccountKey\(me\);/, "")
      .replace(/saveSessionString\(userId/, "saveSessionString(requestedUserId");
    assert.ok(/saveSessionString\(\s*requestedUserId/.test(preFix), "synthetic offender must be detectable");
  });
});

describe("handleOAuthQrLogin persists under a row owned by the scanned account", () => {
  const source = readFileSync(join(SRC, "qr-login.ts"), "utf8");
  const body = functionBody(source, "handleOAuthQrLogin");

  it("resolves the key against row ownership before writing", () => {
    // 2026-11-02: the OAuth flow keyed by `me.username` directly, so the new holder of a
    // released username overwrote the previous owner's row and that owner's tokens then
    // drove the new account.
    assert.match(body, /const userId = await sessions\.resolveAccountKey\(me\)/);
    assert.ok(!/me\.username \?\? String\(me\.id\)/.test(body), "no raw username key");
    assert.match(body, /saveSessionString\(userId, outcome\.sessionString, String\(me\.id\)\)/);
  });
});
