import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * At-rest encryption for the platform's single most valuable secret: the GramJS
 * `session_string` (a serialized, already-authenticated MTProto auth key). A stolen
 * `session_string` grants full read/write access to the owner's Telegram account with
 * no password, SMS, or 2FA — so the on-disk `cloud.db` must never hold them in plaintext.
 *
 * THREAT MODEL — what this defends against, and what it does NOT:
 *   ✅ Scenario A (offline): a stolen disk image, volume snapshot, or backup of `cloud.db`.
 *      The encryption key lives only in the process environment (injected from a GitHub
 *      Secret at deploy time, held in RAM), never on the VDS disk. A dump of the volume
 *      has ciphertext but no key → useless.
 *   ❌ Scenario B (online): root on the live VDS. A process that can read our env / our
 *      RAM can also decrypt, because the running server MUST be able to decrypt to connect
 *      to Telegram on the user's behalf. This is inherent to "server holds always-on
 *      sessions" and is out of scope here — mitigated only by VDS hardening, not crypto.
 *
 * FORMAT:  `v1:<nonce_b64>:<ciphertext||tag_b64>`
 *   - `v1`        version tag → lets us rotate the key without re-logging users in:
 *                 old rows decrypt under their version's key, new writes use the current one.
 *   - nonce       12 random bytes, fresh per write (GCM requirement — never reuse with a key).
 *   - ciphertext  AES-256-GCM output with the 16-byte auth tag appended.
 *
 * KEY:  `SESSION_ENCRYPTION_KEY` — 32 bytes, accepted as 64 hex chars or 44-char base64.
 *       Absent ⇒ PASSTHROUGH mode (self-host / dev / OSS): values are stored as-is and a
 *       one-time warning is logged. The cloud deploy always sets it; passthrough only ever
 *       runs where there is no multi-tenant disk to protect.
 */

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Parse the 32-byte key from hex (64 chars) or base64 (44 chars). Returns null if unset. */
function loadKey(): Buffer | null {
  const raw = config.sessionEncryptionKey;
  if (!raw) return null;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SESSION_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

// Resolve once at module load — the key never changes within a process lifetime.
const KEY = loadKey();
let warnedPassthrough = false;

/** True when an encryption key is configured (i.e. we are in protected mode). */
export function encryptionEnabled(): boolean {
  return KEY !== null;
}

/** True if `stored` is one of our versioned ciphertext envelopes (vs legacy plaintext). */
export function isEncrypted(stored: string): boolean {
  return /^v\d+:/.test(stored);
}

/**
 * Encrypt a secret for storage. In passthrough mode (no key) returns the input unchanged
 * so self-host/dev keep working. Output is the `v1:nonce:ct` envelope.
 */
export function encryptSecret(plaintext: string): string {
  if (!KEY) {
    if (!warnedPassthrough) {
      warnedPassthrough = true;
      logger.warn(
        "SESSION_ENCRYPTION_KEY not set — session strings are stored in PLAINTEXT. " +
          "Set it in production so a stolen disk/backup cannot reuse Telegram sessions.",
      );
    }
    return plaintext;
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, KEY, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([enc, tag]).toString("base64");
  return `${VERSION}:${nonce.toString("base64")}:${payload}`;
}

/**
 * Decrypt a stored value. Backward-compatible by design:
 *   - Legacy plaintext (no `vN:` prefix) is returned unchanged — this is what lets a
 *     freshly-keyed deploy keep reading rows written before encryption, and lets the
 *     OLD container (mid rolling-update, no key) and the NEW container share one volume.
 *   - A `vN:` envelope is decrypted with the key. A missing key against an encrypted
 *     value, or a failed auth-tag check (wrong key / tampered row), throws — callers
 *     treat that as an invalid session and fall back to QR re-login rather than crash.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    // Legacy plaintext — not yet migrated. Return as-is.
    return stored;
  }
  if (!KEY) {
    throw new Error(
      "Encountered an encrypted session_string but SESSION_ENCRYPTION_KEY is not set. " +
        "Refusing to proceed — the key that wrote this row is required to read it.",
    );
  }
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error(`Unsupported session_string envelope: "${parts[0]}:..." (expected ${VERSION})`);
  }
  const nonce = Buffer.from(parts[1], "base64");
  const payload = Buffer.from(parts[2], "base64");
  if (nonce.length !== NONCE_BYTES || payload.length < TAG_BYTES) {
    throw new Error("Malformed session_string envelope (bad nonce/payload length)");
  }
  const enc = payload.subarray(0, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, KEY, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/**
 * Test-only: confirm a round-trip works under the current key. Uses a constant-time
 * compare so the helper can't become a key-probing oracle. @internal
 */
export function _selfTest(sample = "round-trip"): boolean {
  const back = decryptSecret(encryptSecret(sample));
  const a = Buffer.from(back);
  const b = Buffer.from(sample);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Token hashing (one-way, at rest) ────────────────────────────────────────
//
// OAuth access/refresh tokens, auth codes, and client secrets are only ever COMPARED
// (lookup `WHERE token = ?`), never read back — so a one-way hash is strictly safer than
// encryption: a stolen cloud.db yields hashes that cannot be reversed even WITH the key,
// and there is no key to lose. Tokens are 32 random bytes (256 bits of entropy), so a
// bare SHA-256 needs no salt — there is nothing to brute-force or rainbow-table.
//
// CRITICAL — the `h1:` prefix is load-bearing: a legacy plaintext token is
// `randomBytes(32).toString("hex")` = 64 hex chars, and a SHA-256 digest is ALSO 64 hex
// chars, so the two are indistinguishable by shape. Prefixing the stored hash with `h1:`
// makes "already hashed" detectable, so the migration never double-hashes and dual-read
// can match either form unambiguously.
//
// Lookups become `WHERE token = hashToken(incoming) OR token = incoming` (dual-read):
// the client always sends its original plaintext, we hash it to match migrated rows and
// also match any not-yet-migrated legacy row. Migration is transparent to clients.

const HASH_VERSION = "h1";

/** Versioned SHA-256 of a token: `h1:<64-hex>`. Stored in place of the plaintext token. */
export function hashToken(token: string): string {
  return `${HASH_VERSION}:${createHash("sha256").update(token).digest("hex")}`;
}

/** True if `stored` is one of our versioned token hashes (vs a legacy plaintext token). */
export function isHashedToken(stored: string): boolean {
  return /^h\d+:[0-9a-f]{64}$/.test(stored);
}
