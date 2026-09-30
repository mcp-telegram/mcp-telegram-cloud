import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBrowserSessionCookie,
  CLEAR_LEGACY_TG_USER_COOKIE,
  decideSessionHandoff,
  readBrowserSessionToken,
} from "../cookie-handler.js";

const ISSUER = "https://mcp-telegram.com";
const TICKET = "f".repeat(64);
const redeemOnly = (valid: string, userId: string) => (t: string) => (t === valid ? userId : null);

describe("decideSessionHandoff", () => {
  it("returns 204 with the user the ticket was minted for", () => {
    const result = decideSessionHandoff({
      origin: ISSUER,
      issuer: ISSUER,
      body: { handoff: TICKET },
      redeem: redeemOnly(TICKET, "alice_42"),
    });
    assert.deepEqual(result, { status: 204, userId: "alice_42" });
  });

  it("ignores any username the page claims", () => {
    const result = decideSessionHandoff({
      origin: ISSUER,
      issuer: ISSUER,
      body: { handoff: TICKET, username: "someone_else" },
      redeem: redeemOnly(TICKET, "alice_42"),
    });
    assert.deepEqual(result, { status: 204, userId: "alice_42" });
  });

  it("rejects a username without a ticket (the pre-2.61 request shape)", () => {
    const result = decideSessionHandoff({
      origin: ISSUER,
      issuer: ISSUER,
      body: { username: "alice_42" },
      redeem: () => "alice_42",
    });
    assert.equal(result.status, 400);
  });

  it("returns 403 when Origin is missing or foreign", () => {
    for (const origin of [undefined, "https://evil.example", "null"]) {
      const result = decideSessionHandoff({ origin, issuer: ISSUER, body: { handoff: TICKET }, redeem: () => "x" });
      assert.equal(result.status, 403, String(origin));
    }
  });

  it("returns 403 for an unknown, expired or spent ticket", () => {
    const result = decideSessionHandoff({
      origin: ISSUER,
      issuer: ISSUER,
      body: { handoff: TICKET },
      redeem: () => null,
    });
    assert.equal(result.status, 403);
  });

  it("returns 400 for malformed bodies without calling redeem", () => {
    let called = false;
    const redeem = () => {
      called = true;
      return "x";
    };
    for (const body of [null, "str", {}, { handoff: 1 }, { handoff: "short" }, { handoff: `${TICKET}; x=1` }]) {
      assert.equal(decideSessionHandoff({ origin: ISSUER, issuer: ISSUER, body, redeem }).status, 400);
    }
    assert.equal(called, false);
  });
});

describe("browser session cookie", () => {
  it("is HttpOnly, Secure, SameSite=Lax, 30 days by default", () => {
    const cookie = buildBrowserSessionCookie(TICKET);
    assert.match(cookie, new RegExp(`^tg_sid=${TICKET};`));
    for (const flag of ["Path=/", "SameSite=Lax", "Secure", "HttpOnly", "Max-Age=2592000"]) {
      assert.ok(cookie.includes(flag), `missing ${flag}`);
    }
  });

  it("clears the legacy username cookie", () => {
    assert.match(CLEAR_LEGACY_TG_USER_COOKIE, /^tg_user=;/);
    assert.match(CLEAR_LEGACY_TG_USER_COOKIE, /Max-Age=0/);
  });

  it("reads only a well-formed tg_sid", () => {
    assert.equal(readBrowserSessionToken(`a=1; tg_sid=${TICKET}; b=2`), TICKET);
    assert.equal(readBrowserSessionToken(`tg_sid=${TICKET}`), TICKET);
    assert.equal(readBrowserSessionToken(`xtg_sid=${TICKET}`), undefined);
    assert.equal(readBrowserSessionToken("tg_sid=victim"), undefined);
    assert.equal(readBrowserSessionToken("tg_user=victim"), undefined);
    assert.equal(readBrowserSessionToken(undefined), undefined);
  });
});
