/**
 * Browser session cookie (`tg_sid`).
 *
 * Until 2.61 the browser identified itself with `tg_user=<telegram username>`.
 * The server trusted that value, so anyone who knew a username could send the
 * cookie by hand and act as that user: open /my/*, flip the destructive-tools
 * switch, and approve an OAuth code for their own client. The cookie is now an
 * opaque random token that maps to a server-side row (`browser_sessions`), and
 * a row is created only after the server itself saw proof of identity:
 *
 *   - a finished QR login, handed to the page as a one-time ticket
 *     (see `decideSessionHandoff` and `OAuthProvider.createBrowserHandoff`);
 *   - a valid directory-review token (`/review`, `/oauth/authorize/review`).
 *
 * Pure helpers only: no config import, so tests run without runtime ENV.
 */

export const BROWSER_SESSION_COOKIE = "tg_sid";

/** Ordinary sign-in: a month, like the old hint. */
export const BROWSER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Lifetime of the session a review token starts.
 *
 * Longer than the ordinary month on purpose: directory review runs for months,
 * and a session that quietly expires between the reviewer opening the link and
 * returning to finish would drop them on the QR page. Matched to the default
 * review-token TTL so both halves expire together.
 */
export const REVIEW_HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** `Set-Cookie` for a browser session. One builder so the flags cannot drift between issuers. */
export function buildBrowserSessionCookie(token: string, maxAgeSeconds = BROWSER_SESSION_MAX_AGE_SECONDS): string {
  if (!TOKEN_RE.test(token)) throw new Error("unsafe session token");
  return `${BROWSER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure; HttpOnly`;
}

/** Expire the legacy `tg_user` cookie so old browsers stop sending a value nobody reads. */
export const CLEAR_LEGACY_TG_USER_COOKIE = "tg_user=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly";

/**
 * Session token from a `Cookie` header, or undefined.
 *
 * Anchored on start-of-string or `; ` so a cookie named `xtg_sid` is not read,
 * and format-checked so arbitrary text never reaches the database lookup.
 */
export function readBrowserSessionToken(cookieHeader: string | undefined): string | undefined {
  const match = (cookieHeader ?? "").match(/(?:^|;\s*)tg_sid=([^;]+)/);
  const value = match?.[1]?.trim();
  return value && TOKEN_RE.test(value) ? value : undefined;
}

export type HandoffDecision = { status: 204; userId: string } | { status: 400 | 403; body: string };

/**
 * Decide `POST /oauth/authorize/qr/cookie`: trade a one-time QR-login ticket for a session.
 *
 * The ticket, not anything the page says about itself, decides who the session
 * belongs to. The Origin check keeps other sites from spending a ticket that
 * leaked to them.
 */
export function decideSessionHandoff(input: {
  origin: string | undefined;
  issuer: string;
  body: unknown;
  redeem: (ticket: string) => string | null;
}): HandoffDecision {
  if (!input.origin || input.origin !== input.issuer) {
    return { status: 403, body: "forbidden" };
  }
  const ticket =
    input.body !== null && typeof input.body === "object" && "handoff" in input.body
      ? (input.body as { handoff?: unknown }).handoff
      : undefined;
  if (typeof ticket !== "string" || !TOKEN_RE.test(ticket)) {
    return { status: 400, body: "bad request" };
  }
  const userId = input.redeem(ticket);
  if (!userId) return { status: 403, body: "expired or already used" };
  return { status: 204, userId };
}
