/**
 * Pure decision function for the POST /oauth/authorize/qr/cookie endpoint.
 * Extracted so unit tests don't need to spin up a full Hono app or import
 * config.ts (which requires runtime ENV).
 *
 * Behaviour:
 *   - reject if Origin header is missing or not equal to the configured ISSUER
 *     (CSRF protection — same-origin only)
 *   - reject if body could not be parsed or username doesn't match the
 *     Telegram public-username grammar (5-32 chars, must start with a letter,
 *     then letters / digits / underscore). Storing usernames that can never
 *     match a real saved session would only force users back through QR.
 *   - on success return a Set-Cookie header for the `tg_user` hint with
 *     HttpOnly + Secure + SameSite=Lax + Max-Age=30d
 */

const TG_USER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Lifetime for the hint written by a review link.
 *
 * Longer than the ordinary 30 days on purpose: directory review runs for
 * months, and a hint that quietly expires between the reviewer opening the link
 * and returning to finish would drop them on the QR page — a dead end they
 * cannot pass, and one that reads as "we could not connect to your server".
 * Matched to the default review-token TTL so both halves expire together
 * instead of one outliving the other.
 */
export const REVIEW_HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
// Telegram public usernames: 5-32 chars, leading letter, letters/digits/underscore.
// The character set also keeps the value cookie-safe (no quoting / CRLF smuggling).
const TG_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/**
 * Session-hint cookie read back by the OAuth fast path. One builder so the
 * flags cannot drift between the two issuers (the QR page and the review link)
 * — a hint that silently lost `Secure` or `HttpOnly` in one of them would be
 * invisible in tests that only assert the value.
 *
 * `userId` is `user_sessions.user_id`: a Telegram username, or the numeric id
 * as a string for accounts without one. Percent-encoded because the reader
 * decodes, and rejected outright if it could break out of the cookie value.
 */
export function buildTgUserCookie(userId: string, maxAgeSeconds = TG_USER_MAX_AGE_SECONDS): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(userId)) throw new Error("unsafe tg_user value");
  return `tg_user=${encodeURIComponent(userId)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure; HttpOnly`;
}

export type CookieDecision = { status: 204; setCookie: string } | { status: 400 | 403; body: string };

export function decideTgUserCookie(input: {
  origin: string | undefined;
  issuer: string;
  body: { username?: unknown } | null;
}): CookieDecision {
  if (!input.origin || input.origin !== input.issuer) {
    return { status: 403, body: "forbidden" };
  }
  if (input.body === null || typeof input.body !== "object") {
    return { status: 400, body: "bad request" };
  }
  const username = typeof input.body.username === "string" ? input.body.username : "";
  // Reject the literal sentinel "unknown" — the QR layer emits it for accounts
  // without a public username, and storing it as a session hint would
  // permanently misroute future logins.
  if (username === "unknown" || !TG_USERNAME_RE.test(username)) {
    return { status: 400, body: "bad request" };
  }
  return { status: 204, setCookie: buildTgUserCookie(username) };
}
