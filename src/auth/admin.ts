import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/** Constant-time comparison of admin Bearer token to prevent timing attacks. */
export function isAdminAuthorized(authHeader: string | undefined): boolean {
  if (!config.adminToken || !authHeader) return false;
  const expected = `Bearer ${config.adminToken}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Admin password (for the /admin-login gate in front of /oauth/authorize) ──
//
// scrypt, not the SHA-256 used for OAuth token hashing in crypto.ts: those
// tokens are 256 bits of random entropy with nothing to brute-force, but a
// human-chosen password needs a deliberately slow, salted KDF. Format
// mirrors crypto.ts's versioned-envelope convention (`v1:`/`h1:`) so a future
// algorithm change stays detectable and migratable: `s1:<salt_hex>:<hash_hex>`.

const PASSWORD_HASH_VERSION = "s1";
const SALT_BYTES = 16;
const KEY_LEN = 64;

/** Hash a plaintext admin password for storage in ADMIN_PASSWORD_HASH.
 *  Run via `bun scripts/hash-admin-password.ts`, never at request time. */
export function hashAdminPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `${PASSWORD_HASH_VERSION}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Verify a login attempt against the stored ADMIN_PASSWORD_HASH. Never
 *  throws on a malformed stored value — treats it as "no match". */
export function verifyAdminPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== PASSWORD_HASH_VERSION) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LEN) return false;
  const actual = scryptSync(password, salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}

// ── Admin session cookie ──────────────────────────────────────────────────
//
// Self-authenticating (no server-side session table): the cookie's own HMAC
// signature IS the credential, keyed by ADMIN_PASSWORD_HASH (a secret only
// this server holds — rotating the admin password also invalidates every
// outstanding admin session, which is the desired behaviour).

const ADMIN_COOKIE_NAME = "admin_session";
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days, sliding on each login

function adminSigningKey(): Buffer {
  return Buffer.from(config.adminPasswordHash);
}

/** Issue a Set-Cookie header value for a freshly authenticated admin. */
export function buildAdminSessionCookie(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_MAX_AGE_SECONDS;
  const payload = String(expiresAt);
  const sig = createHmac("sha256", adminSigningKey()).update(payload).digest("hex");
  return `${ADMIN_COOKIE_NAME}=${payload}.${sig}; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}; SameSite=Lax; Secure; HttpOnly`;
}

/** Validate a raw `Cookie` request header (or a single `name=value` pair, as
 *  tests pass) for a still-valid, correctly-signed admin session. */
export function isAdminSessionValid(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  // Fail closed on an empty signing key. server.tsx already refuses to boot
  // with an empty ADMIN_PASSWORD_HASH, but this function shouldn't rely on a
  // non-local invariant enforced in a different file for its own core
  // security property — an empty HMAC key makes every session cookie forgeable.
  if (!config.adminPasswordHash) return false;
  try {
    // Anchored to the start of the header or right after a `; ` separator, so
    // this can't match `xadmin_session=...` (a different cookie whose name
    // merely ends in the same substring) or a value elsewhere in the header
    // that happens to contain the literal text `admin_session=`.
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE_NAME}=([^;]+)`));
    if (!match) return false;
    const value = decodeURIComponent(match[1]);
    const dot = value.lastIndexOf(".");
    if (dot === -1) return false;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = createHmac("sha256", adminSigningKey()).update(payload).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const expiresAt = Number(payload);
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
