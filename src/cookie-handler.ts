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
// Telegram public usernames: 5-32 chars, leading letter, letters/digits/underscore.
// The character set also keeps the value cookie-safe (no quoting / CRLF smuggling).
const TG_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

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
  return {
    status: 204,
    setCookie: `tg_user=${username}; Path=/; Max-Age=${TG_USER_MAX_AGE_SECONDS}; SameSite=Lax; Secure; HttpOnly`,
  };
}
