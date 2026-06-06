/**
 * At-rest encryption of session_string (src/crypto.ts).
 *
 * The module resolves its key ONCE at import from `config.sessionEncryptionKey`, which in
 * turn reads `process.env.SESSION_ENCRYPTION_KEY`. Static `import` is hoisted above the env
 * assignment, so config would see an empty ISSUER/key — we therefore set env first, then pull
 * crypto via dynamic `await import` (the same env-before-import pattern as the other
 * SessionManager tests). A 64-hex key is used here.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "deadbeefdeadbeefdeadbeefdeadbeef";
// 32 bytes as 64 hex chars.
process.env.SESSION_ENCRYPTION_KEY = "0".repeat(64);

import { describe, expect, test } from "bun:test";

const { _selfTest, decryptSecret, encryptionEnabled, encryptSecret, isEncrypted } = await import("../crypto.js");

describe("crypto: session_string at-rest encryption", () => {
  test("encryptionEnabled() is true when a key is configured", () => {
    expect(encryptionEnabled()).toBe(true);
  });

  test("round-trips arbitrary plaintext", () => {
    const samples = [
      "1ApWapzMBu4...fakegramjssessionstring==",
      "",
      "短い", // multibyte / UTF-8
      "a".repeat(4096),
      "v1:looks-like-but-is-actually-plaintext", // tricky: contains a colon
    ];
    for (const s of samples) {
      const enc = encryptSecret(s);
      expect(decryptSecret(enc)).toBe(s);
    }
  });

  test("ciphertext is versioned, non-deterministic, and not the plaintext", () => {
    const plain = "session-abc";
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a.startsWith("v1:")).toBe(true);
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toBe(plain);
    // Fresh nonce per write → same plaintext yields different envelopes (no ECB-style leak).
    expect(a).not.toBe(b);
  });

  test("legacy plaintext (no vN: prefix) decrypts to itself — backward compatible", () => {
    const legacy = "1ApWapzMBu4plaintextsession==";
    expect(isEncrypted(legacy)).toBe(false);
    expect(decryptSecret(legacy)).toBe(legacy);
  });

  test("tampered ciphertext fails the auth tag (throws, no silent corruption)", () => {
    const enc = encryptSecret("secret");
    const [v, nonce, payload] = enc.split(":");
    // Flip a bit in the first ciphertext byte (decode → mutate → re-encode) so the change
    // is real at the byte level — flipping the last base64 CHAR can be a no-op since the
    // final char carries fewer than 6 significant bits.
    const buf = Buffer.from(payload, "base64");
    buf[0] ^= 0x01;
    expect(() => decryptSecret(`${v}:${nonce}:${buf.toString("base64")}`)).toThrow();
  });

  test("malformed envelope throws rather than returning garbage", () => {
    expect(() => decryptSecret("v1:onlytwo")).toThrow();
    expect(() => decryptSecret("v9:abc:def")).toThrow(); // unknown version
  });

  test("_selfTest confirms a constant-time round-trip", () => {
    expect(_selfTest()).toBe(true);
  });
});
