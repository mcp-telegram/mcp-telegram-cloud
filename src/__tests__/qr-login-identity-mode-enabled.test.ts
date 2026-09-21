/**
 * Task 3 (2026-09-19-optional-single-operator-mode): paired on-path case for
 * `qr-login-identity-mode.test.ts` — see that file's header for full context.
 *
 * This file covers SINGLE_OPERATOR_MODE=true: the scanned session must be
 * saved under the fixed `config.ownerUserId`, never the self-reported
 * Telegram identity, matching `handleQrLogin`'s and `handleAddAccountQr`'s
 * existing single-operator behavior. Split into its own file/process because
 * `config` is a module-level singleton computed once from `process.env` at
 * import time (see `config-single-operator-mode-enabled.test.ts` for the
 * established convention).
 */
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";
process.env.SINGLE_OPERATOR_MODE ??= "true";

import { describe, expect, it, mock } from "bun:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { OAuthProvider } from "../oauth.js";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

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

describe("handleOAuthQrLogin — identity save path (SINGLE_OPERATOR_MODE=true)", () => {
  it("saves under config.ownerUserId, not the self-reported Telegram identity", async () => {
    expect(config.singleOperatorMode).toBe(true); // sanity: proves this file exercises the on-path
    expect(config.ownerUserId).toBe("admin:alice");

    identities.clear();
    // Deliberately a DIFFERENT handle than the owner username — proves the
    // save key is the fixed owner id, not derived from this identity at all.
    identities.set("scanned-session-str", { id: 777, username: "some_other_handle" });
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
    expect(saveCalls).toEqual([["admin:alice", "scanned-session-str"]]);
    expect(saveCalls.some(([userId]) => userId === "some_other_handle")).toBe(false);
  });
});
