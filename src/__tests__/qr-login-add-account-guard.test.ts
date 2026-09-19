/**
 * Finding 3 (final-branch review, 2026-09-18-single-operator-auth) and
 * finding 2 (final-branch review, 2026-09-19-optional-single-operator-mode):
 * `handleAddAccountQr`'s "don't double-bind the primary account" guard in
 * qr-login.ts used to compare the scanned account's Telegram handle/id
 * against `ownerUserId` — reasoned (incorrectly, as it turns out) to be a
 * fixed `admin:<username>` key from a completely different namespace, so
 * the comparison could never fire (dead code).
 *
 * That reasoning only holds in single-operator mode. In multi-tenant mode
 * (the default, flag off), `ownerUserId` IS a Telegram handle — same
 * namespace as `telegramUserId` — so the ORIGINAL plain string compare is
 * still correct and still needed there. The current guard keeps BOTH
 * checks:
 *  - the string compare (`telegramUserId === ownerUserId`), which fires in
 *    multi-tenant mode and runs unconditionally, with no dependency on the
 *    primary session being reachable;
 *  - the id-based compare, which fires in single-operator mode by comparing
 *    the scanned account's real Telegram `id` against the PRIMARY account's
 *    live Telegram `id` (fetched via
 *    `sessions.getOrCreateSession(ownerUserId).getMe()`), and fails open
 *    (logs a warning, allows the add) if that lookup can't complete.
 *
 * `runQrLogin` (qr-login-core.ts) is mocked out via `mock.module` — it talks
 * to live GramJS and isn't worth a full network-shaped fake for this guard's
 * logic. `SessionManager`'s own `telegramFactory` injection point (the
 * codebase's established way to substitute the Telegram client — see
 * session-manager-accounts.test.ts) supplies a stub whose `getMe()` returns a
 * per-session-string identity the test controls, so both the "scanned"
 * connection and the "reconnect the primary" connection can be driven
 * independently within one test.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import { describe, expect, it, mock } from "bun:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

// Controlled per-test; the mocked runQrLogin always resolves with this.
let mockOutcome: { ok: boolean; sessionString?: string; message?: string } = { ok: false, message: "not set" };

mock.module("../qr-login-core.js", () => ({
  runQrLogin: async () => mockOutcome,
}));

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { handleAddAccountQr } = await import("../qr-login.js");

type Identity = { id: string; username?: string; firstName?: string };

/** Session-string → fake Telegram identity, shared by every stub instance the
 *  factory below creates (each StubTelegramService looks itself up by
 *  whatever `setSessionString` set on it). Cleared/repopulated per test. */
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

/**
 * Drain an SSE ReadableStream into {event, data} pairs, skipping heartbeat
 * comments, stopping as soon as a terminal event (`error_msg` or `added`)
 * has been seen.
 *
 * Not a `while (!done)` loop to EOF: both terminal branches in
 * `handleAddAccountQr` `return` from inside the outer `try`, which (pre-
 * existing behaviour, unrelated to this guard fix — `controller.close()`
 * sits after the try/catch/finally, so an early `return` skips it) never
 * formally closes the stream. The real client is an EventSource that just
 * reacts to the event and doesn't care whether the stream closes, so this
 * mirrors that rather than waiting on a close that only the success path
 * without an early return actually sends.
 */
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
      if (events.some((e) => e.event === "error_msg" || e.event === "added")) break;
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

const OWNER = "admin:alice";

describe("handleAddAccountQr — primary double-bind guard", () => {
  it("refuses the add via the plain string compare when telegramUserId === ownerUserId (multi-tenant mode) — even when the primary session can't be verified", async () => {
    identities.clear();
    identities.set("scanned-same-handle", { id: "777", username: "alice_tg" });
    mockOutcome = { ok: true, sessionString: "scanned-same-handle" };

    const sm = makeManager();
    // Deliberately NOT saving a primary session for OWNER_HANDLE. If the
    // string-compare check didn't fire first, the id-based fallback would
    // throw (getOrCreateSession has nothing to reconnect) and fail OPEN,
    // allowing the add through. The string compare must catch this before
    // that fallback is ever reached.
    const OWNER_HANDLE = "alice_tg"; // multi-tenant mode: ownerUserId IS the Telegram handle

    const events = await collectEvents(await handleAddAccountQr(sm, OWNER_HANDLE, null, new AbortController().signal));

    const error = events.find((e) => e.event === "error_msg") as { data: { message: string } } | undefined;
    expect(error).toBeDefined();
    expect(error?.data.message).toMatch(/already your primary account/);
    expect(events.some((e) => e.event === "added")).toBe(false);
    expect(sm.listAccounts(OWNER_HANDLE).filter((a) => !a.isPrimary)).toEqual([]);
  });

  it("refuses the add when the scanned account's Telegram id matches the primary's", async () => {
    identities.clear();
    identities.set("primary-session-str", { id: "555", username: "alice_tg" });
    identities.set("scanned-same-account", { id: "555", username: "alice_tg" }); // same id — same physical account
    mockOutcome = { ok: true, sessionString: "scanned-same-account" };

    const sm = makeManager();
    sm.saveSessionString(OWNER, "primary-session-str");

    const events = await collectEvents(await handleAddAccountQr(sm, OWNER, null, new AbortController().signal));

    const error = events.find((e) => e.event === "error_msg") as { data: { message: string } } | undefined;
    expect(error).toBeDefined();
    expect(error?.data.message).toMatch(/already your primary account/);
    expect(events.some((e) => e.event === "added")).toBe(false);
    expect(sm.listAccounts(OWNER).filter((a) => !a.isPrimary)).toEqual([]);
  });

  it("allows the add when the scanned account's Telegram id differs from the primary's", async () => {
    identities.clear();
    identities.set("primary-session-str", { id: "555", username: "alice_tg" });
    identities.set("scanned-different-account", { id: "999", username: "bob_tg" });
    mockOutcome = { ok: true, sessionString: "scanned-different-account" };

    const sm = makeManager();
    sm.saveSessionString(OWNER, "primary-session-str");

    const events = await collectEvents(await handleAddAccountQr(sm, OWNER, null, new AbortController().signal));

    expect(events.some((e) => e.event === "error_msg")).toBe(false);
    expect(events.some((e) => e.event === "added")).toBe(true);
    const secondaries = sm.listAccounts(OWNER).filter((a) => !a.isPrimary);
    expect(secondaries.length).toBe(1);
    expect(secondaries[0].telegramUserId).toBe("bob_tg");
  });

  it("fails open (allows the add, doesn't crash) when the primary's identity can't be verified", async () => {
    identities.clear();
    // Deliberately no identity registered for any session string the primary
    // connect will use (and no saved primary session at all), so the guard's
    // `primaryTelegram.getMe()` call throws — simulating "primary session
    // invalid / not yet connected".
    identities.set("scanned-account-c", { id: "42", username: "carol_tg" });
    mockOutcome = { ok: true, sessionString: "scanned-account-c" };

    const sm = makeManager();
    // No sm.saveSessionString(OWNER, ...) — primary has no stored session.

    const events = await collectEvents(await handleAddAccountQr(sm, OWNER, null, new AbortController().signal));

    expect(events.some((e) => e.event === "error_msg")).toBe(false);
    expect(events.some((e) => e.event === "added")).toBe(true);
    const secondaries = sm.listAccounts(OWNER).filter((a) => !a.isPrimary);
    expect(secondaries.length).toBe(1);
  });
});
