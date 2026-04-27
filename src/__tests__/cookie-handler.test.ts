import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideTgUserCookie } from "../cookie-handler.js";

const ISSUER = "https://mcp-telegram.com";

describe("decideTgUserCookie", () => {
  it("returns 204 + HttpOnly Set-Cookie for a valid same-origin request", () => {
    const result = decideTgUserCookie({
      origin: ISSUER,
      issuer: ISSUER,
      body: { username: "alice_42" },
    });
    assert.equal(result.status, 204);
    if (result.status !== 204) return; // type narrowing
    assert.match(result.setCookie, /^tg_user=alice_42;/);
    assert.match(result.setCookie, /HttpOnly/);
    assert.match(result.setCookie, /Secure/);
    assert.match(result.setCookie, /SameSite=Lax/);
    assert.match(result.setCookie, /Path=\//);
    assert.match(result.setCookie, /Max-Age=2592000/); // 30 days
  });

  it("returns 403 when Origin header is missing", () => {
    const result = decideTgUserCookie({
      origin: undefined,
      issuer: ISSUER,
      body: { username: "alice" },
    });
    assert.equal(result.status, 403);
  });

  it("returns 403 when Origin does not match issuer (CSRF protection)", () => {
    const result = decideTgUserCookie({
      origin: "https://evil.example",
      issuer: ISSUER,
      body: { username: "alice" },
    });
    assert.equal(result.status, 403);
  });

  it("returns 400 when body is null (malformed JSON)", () => {
    const result = decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: null });
    assert.equal(result.status, 400);
  });

  it("returns 400 when username is missing", () => {
    const result = decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: {} });
    assert.equal(result.status, 400);
  });

  it("returns 400 when username is the string 'unknown'", () => {
    const result = decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: { username: "unknown" } });
    assert.equal(result.status, 400);
  });

  it("returns 400 when username is not a string (number, object)", () => {
    assert.equal(decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: { username: 123 } }).status, 400);
    assert.equal(decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: { username: {} } }).status, 400);
  });

  it("returns 400 when username exceeds Telegram's 32-char limit", () => {
    const result = decideTgUserCookie({
      origin: ISSUER,
      issuer: ISSUER,
      body: { username: "a".repeat(33) },
    });
    assert.equal(result.status, 400);
  });

  it("returns 400 when username is shorter than Telegram's 5-char minimum", () => {
    for (const tooShort of ["a", "ab", "abc", "abcd"]) {
      const result = decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: { username: tooShort } });
      assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(tooShort)}`);
    }
  });

  it("returns 400 when username does not start with a letter (Telegram rule)", () => {
    for (const badStart of ["1abcd", "_abcd", "9user1", "_underscore"]) {
      const result = decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: { username: badStart } });
      assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(badStart)}`);
    }
  });

  it("accepts usernames at the boundary (5 chars and 32 chars, leading letter)", () => {
    const five = decideTgUserCookie({ origin: ISSUER, issuer: ISSUER, body: { username: "abcde" } });
    assert.equal(five.status, 204);
    const thirtyTwo = decideTgUserCookie({
      origin: ISSUER,
      issuer: ISSUER,
      body: { username: `a${"b".repeat(31)}` },
    });
    assert.equal(thirtyTwo.status, 204);
  });

  it("rejects usernames containing characters outside [A-Za-z0-9_] (cookie smuggling guard)", () => {
    for (const bad of ["alice; Path=/admin", "bob\r\nSet-Cookie: x=y", "carol bob", "evil%2F", "name.dot"]) {
      const result = decideTgUserCookie({
        origin: ISSUER,
        issuer: ISSUER,
        body: { username: bad },
      });
      assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });
});
