/**
 * Task 3 (2026-09-19-optional-single-operator-mode): `handleOAuthQrLogin`'s
 * QR-scan success path used to ALWAYS save the freshly-bootstrapped Telegram
 * session under `config.ownerUserId`, regardless of `SINGLE_OPERATOR_MODE` —
 * a leftover from the single-operator fork that broke the off-path (default,
 * multi-tenant) mode Task 2 restored: a fresh QR login there has nothing
 * correct saved for the `tg_user`-cookie hint fast path to match against.
 *
 * This file covers the off-path (SINGLE_OPERATOR_MODE unset/false): the
 * scanned session must be saved under the self-reported Telegram identity
 * (`me.username ?? String(me.id)`), upstream's original behavior.
 *
 * The paired on-path case (SINGLE_OPERATOR_MODE=true → saves under
 * `config.ownerUserId`) lives in `qr-login-identity-mode-enabled.test.ts` —
 * `config` is a module-level singleton computed once from `process.env` at
 * import time (see `config-single-operator-mode.test.ts` /
 * `config-single-operator-mode-enabled.test.ts` for the established
 * one-file-per-value convention), so both values can't be exercised from a
 * single test file/process.
 *
 * `runQrLogin` (qr-login-core.ts) is mocked via `mock.module` — same
 * convention as `qr-login-add-account-guard.test.ts` and
 * `oauth-authorize-multi-tenant.test.ts` — so this never attempts a real
 * Telegram/GramJS connection. The Telegram client itself is substituted via
 * `SessionManager`'s injectable `telegramFactory` (also
 * `qr-login-add-account-guard.test.ts`'s pattern), with a stub `getMe()`
 * keyed by session string.
 */
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";

// Deliberately NOT setting SINGLE_OPERATOR_MODE — this file proves the
// default (off) behavior.

import { describe, expect, it, mock } from "bun:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { OAuthProvider } from "../oauth.js";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

// Controlled per-test; the mocked runQrLogin always resolves with this.
let mockOutcome: { ok: boolean; sessionString?: string; message?: string } = { ok: false, message: "not set" };

mock.module("../qr-login-core.js", () => ({
  runQrLogin: async () => mockOutcome,
}));

const { config } = await import("../config.js");
const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { handleOAuthQrLogin } = await import("../qr-login.js");

type Identity = { id: number; username?: string; firstName?: string };

/** Session-string → fake Telegram identity, mirroring
 *  qr-login-add-account-guard.test.ts's StubTelegramService pattern. */
const identities = new Map<string, Identity>();

class StubTelegramService {
  private connected = false;
  private sessionString: string | undefined;

  async connect(): Promise<boolean> {
    this.connected = true;
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async ensureConnected(): Promise<boolean> {
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async logOut(): Promise<boolean> {
    return true;
  }
  setSessionString(s: string): void {
    this.sessionString = s;
  }
  getSessionString(): string | undefined {
    return this.sessionString;
  }
  async getMe(): Promise<Identity> {
    const identity = identities.get(this.sessionString ?? "");
    if (!identity) {
      throw new Error(`stub: no fake identity registered for session ${JSON.stringify(this.sessionString)}`);
    }
    return identity;
  }
}

function makeManager(): SessionManagerType {
  return new SessionManager(":memory:", () => new StubTelegramService() as unknown as TelegramService);
}

const oauthStub = {
  getClient: (id: string) =>
    id === "known"
      ? { client_id: "known", client_name: "Test", redirect_uris: JSON.stringify(["https://client.example/cb"]) }
      : undefined,
  clientCount: () => 0,
  createAuthCode: (_args: unknown) => "test-code",
} as unknown as OAuthProvider;

const OAUTH_PARAMS = {
  clientId: "known",
  redirectUri: "https://client.example/cb",
  state: "xyz",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
};

/** Drain the SSE stream, stopping once a terminal event (`redirect` or
 *  `error_msg`) is seen. Mirrors qr-login-add-account-guard.test.ts's
 *  collectEvents — handleOAuthQrLogin's success branch also returns from
 *  inside the outer try without a formal stream close on some paths. */
async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<Array<{ event: string; data: unknown }>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let idx: number;
      // biome-ignore lint: straightforward frame-splitting loop
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!frame.trim() || frame.startsWith(":")) continue;
        const eventMatch = frame.match(/^event: (.+)$/m);
        const dataMatch = frame.match(/^data: (.+)$/m);
        if (eventMatch && dataMatch) {
          events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) });
        }
      }
      if (events.some((e) => e.event === "redirect" || e.event === "error_msg")) break;
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

describe("handleOAuthQrLogin — identity save path (SINGLE_OPERATOR_MODE unset)", () => {
  it("saves under the self-reported Telegram identity, not config.ownerUserId", async () => {
    expect(config.singleOperatorMode).toBe(false); // sanity: proves this file exercises the off-path

    identities.clear();
    identities.set("scanned-session-str", { id: 777, username: "some_handle" });
    mockOutcome = { ok: true, sessionString: "scanned-session-str" };

    const sm = makeManager();
    const saveCalls: Array<[string, string]> = [];
    const originalSave = sm.saveSessionString.bind(sm);
    sm.saveSessionString = (userId: string, sessionString: string) => {
      saveCalls.push([userId, sessionString]);
      return originalSave(userId, sessionString);
    };

    const events = await collectEvents(
      await handleOAuthQrLogin(sm, oauthStub, OAUTH_PARAMS, undefined, new AbortController().signal),
    );

    expect(events.some((e) => e.event === "redirect")).toBe(true);
    expect(saveCalls).toEqual([["some_handle", "scanned-session-str"]]);
    expect(saveCalls.some(([userId]) => userId === config.ownerUserId)).toBe(false);
    expect(saveCalls.some(([userId]) => userId === "admin:alice")).toBe(false);
  });

  it("falls back to the numeric id when the scanned account has no username", async () => {
    identities.clear();
    identities.set("scanned-session-no-username", { id: 999 });
    mockOutcome = { ok: true, sessionString: "scanned-session-no-username" };

    const sm = makeManager();
    const saveCalls: Array<[string, string]> = [];
    const originalSave = sm.saveSessionString.bind(sm);
    sm.saveSessionString = (userId: string, sessionString: string) => {
      saveCalls.push([userId, sessionString]);
      return originalSave(userId, sessionString);
    };

    const events = await collectEvents(
      await handleOAuthQrLogin(sm, oauthStub, OAUTH_PARAMS, undefined, new AbortController().signal),
    );

    expect(events.some((e) => e.event === "redirect")).toBe(true);
    expect(saveCalls).toEqual([["999", "scanned-session-no-username"]]);
  });
});
