/**
 * GramJS-backed QR + 2FA login core (qr-login-core.ts).
 *
 * Uses an injected fake client that emulates GramJS's `signInUserWithQrCode`
 * contract — it drives the `qrCode`/`password`/`onError` callbacks exactly the
 * way GramJS does, including the SESSION_PASSWORD_NEEDED retry loop — so we can
 * exercise the 2FA paths without any network.
 *
 * Covers:
 *   - no-2FA success → ok + sessionString, QR emitted, password never requested
 *   - 2FA success on first try → password requested, status surfaced
 *   - wrong-then-right password → onPasswordRejected fired, retry succeeds
 *   - too many wrong passwords → aborts after MAX attempts with a clear message
 *   - already-aborted signal → no client created, ok:false
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QrClientFactory, QrLoginHooks } from "../qr-login-core.js";

const { runQrLogin } = await import("../qr-login-core.js");

const VALID_SESSION = "S".repeat(120);

type FakeOpts = {
  needs2fa?: boolean;
  correctPassword?: string;
  session?: string;
  created?: { count: number };
};

/** Build a fake client factory that mimics GramJS's QR sign-in contract. */
function fakeFactory(opts: FakeOpts): QrClientFactory {
  return () => {
    if (opts.created) opts.created.count += 1;
    return {
      connect: async () => true,
      saveSession: () => opts.session ?? VALID_SESSION,
      destroy: async () => {},
      signInUserWithQrCode: async (_creds, params) => {
        await params.qrCode({ token: Buffer.from("token-bytes"), expires: 0 });
        if (!opts.needs2fa) return {};
        // Emulate the GramJS SESSION_PASSWORD_NEEDED loop.
        while (true) {
          let pw: string | undefined;
          try {
            pw = await params.password?.("my-hint");
          } catch (err) {
            const stop = await params.onError(err as Error);
            if (stop) throw new Error("AUTH_USER_CANCEL");
            continue;
          }
          if (pw === opts.correctPassword) return {};
          const invalid = Object.assign(new Error("invalid"), { errorMessage: "PASSWORD_HASH_INVALID" });
          const stop = await params.onError(invalid);
          if (stop) throw new Error("AUTH_USER_CANCEL");
        }
      },
    };
  };
}

function collectingHooks(passwords: string[]): QrLoginHooks & {
  qrCount: number;
  statuses: string[];
  rejected: number;
  requested: number;
} {
  const state = { qrCount: 0, statuses: [] as string[], rejected: 0, requested: 0 };
  return {
    ...state,
    onQr() {
      this.qrCount += 1;
    },
    onStatus(m: string) {
      this.statuses.push(m);
    },
    onPasswordRejected() {
      this.rejected += 1;
    },
    async requestPassword() {
      const next = passwords[this.requested] ?? "";
      this.requested += 1;
      return next;
    },
  } as QrLoginHooks & { qrCount: number; statuses: string[]; rejected: number; requested: number };
}

describe("qr-login-core", () => {
  it("succeeds without 2FA and never asks for a password", async () => {
    const hooks = collectingHooks([]);
    const ac = new AbortController();
    const outcome = await runQrLogin(hooks, ac.signal, fakeFactory({}));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionString, VALID_SESSION);
    assert.equal(hooks.qrCount, 1);
    assert.equal(hooks.requested, 0);
  });

  it("completes the 2FA flow when the right cloud password is supplied", async () => {
    const hooks = collectingHooks(["correct-horse"]);
    const ac = new AbortController();
    const outcome = await runQrLogin(
      hooks,
      ac.signal,
      fakeFactory({ needs2fa: true, correctPassword: "correct-horse" }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionString, VALID_SESSION);
    assert.equal(hooks.requested, 1);
    assert.equal(hooks.rejected, 0);
    // The 2FA status line was surfaced.
    assert.ok(hooks.statuses.some((s) => /two-factor/i.test(s)));
  });

  it("retries after a wrong password and then succeeds", async () => {
    const hooks = collectingHooks(["nope", "correct-horse"]);
    const ac = new AbortController();
    const outcome = await runQrLogin(
      hooks,
      ac.signal,
      fakeFactory({ needs2fa: true, correctPassword: "correct-horse" }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(hooks.requested, 2);
    assert.equal(hooks.rejected, 1);
  });

  it("gives up after too many wrong passwords", async () => {
    const hooks = collectingHooks(["a", "b", "c", "d", "e"]);
    const ac = new AbortController();
    const outcome = await runQrLogin(hooks, ac.signal, fakeFactory({ needs2fa: true, correctPassword: "never" }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.message ?? "", /too many/i);
    // Capped at MAX_PASSWORD_ATTEMPTS (3) prompts.
    assert.equal(hooks.requested, 3);
  });

  it("returns aborted without creating a client when the signal is already aborted", async () => {
    const hooks = collectingHooks([]);
    const ac = new AbortController();
    ac.abort();
    const created = { count: 0 };
    const outcome = await runQrLogin(hooks, ac.signal, fakeFactory({ created }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.message ?? "", /abort/i);
    assert.equal(created.count, 0);
  });
});
