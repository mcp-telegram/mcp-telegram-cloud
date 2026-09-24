import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import { buildTgUserCookie, decideTgUserCookie, REVIEW_HINT_MAX_AGE_SECONDS } from "../cookie-handler.js";
import { logger, logUser } from "../logger.js";
import type { OAuthProvider } from "../oauth.js";
import { AuthorizePage } from "../pages/AuthorizePage.js";
import { ConsentPage } from "../pages/ConsentPage.js";
import { handleOAuthQrLogin } from "../qr-login.js";
import { oauthRateLimit, registerRateLimit, reviewRateLimit } from "../rate-limit.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import { redirectOrigin } from "../redirect-origin.js";
import { matchRedirectUri } from "../redirect-uri-matcher.js";
import type { SessionManager } from "../session-manager.js";
import { incr, OAUTH_FLOW } from "../telemetry/metrics.js";
import { extractReviewToken, reviewPage } from "./review.js";

export interface OAuthRoutesDeps {
  oauth: OAuthProvider;
  sessions: SessionManager;
}

function getUserIdHint(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/tg_user=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Registered redirect URIs for a client. The column is written by our own
 * registration code as a JSON array, but a hand-edited or half-migrated row
 * must not turn /authorize into a 500. Unparsable becomes an empty list, which
 * fails CLOSED at matchRedirectUri ("Invalid redirect_uri"), never open.
 */
function parsedRedirectUris(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Build the `redirect_uri?code=…&state=…` destination. Returns null when the
 * URI cannot be parsed; callers must then refuse rather than redirect to
 * something half-formed. In practice matchRedirectUri has already accepted it.
 */
function buildCodeRedirect(redirectUri: string, code: string, state: string): string | null {
  try {
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return url.toString();
  } catch {
    return null;
  }
}

async function parseTokenParams(c: Context): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.formData();
    return Object.fromEntries(form.entries()) as Record<string, string>;
  }
  return c.req.json();
}

/**
 * RFC 9728 protected-resource metadata document.
 *
 * `resource` must be the canonical identifier of the resource the client is
 * actually calling. For the MCP transport that is `<issuer>/mcp`, not the bare
 * issuer — a client that validates the document against the endpoint it is
 * talking to rejects a mismatched identifier.
 */
export function protectedResourceMetadata(resource: string) {
  return {
    resource,
    authorization_servers: [config.issuer],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
  };
}

/** Path where a client discovers metadata for the `/mcp` resource (RFC 9728 §3.1). */
export const MCP_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

/**
 * Absolute URL for a path this server mounts at its ROOT, derived from `issuer`.
 *
 * Deliberately resolves against the issuer's *origin*, discarding any path
 * component. ISSUER is only validated as an http(s) URL, so `https://host/base`
 * is accepted — and naive concatenation would then advertise
 * `https://host/base/.well-known/...`, which nothing serves, because every route
 * here is mounted at `/`. Resolving through `URL` also normalises the result, so
 * a stray quote in the configured value cannot escape the quoted
 * `resource_metadata="..."` parameter of a WWW-Authenticate header.
 *
 * Returns `origin + path`, dropping any userinfo the issuer might carry so it
 * cannot be republished as discovery metadata. No try/catch fallback on
 * purpose: `config.issuerUrl` validates ISSUER at boot, so an unparseable value
 * can never reach here — and a silent concatenating fallback would quietly
 * reintroduce exactly the malformed URL this function exists to prevent.
 */
export function rootUrl(issuer: string, path: string): string {
  const url = new URL(path, issuer);
  return `${url.origin}${url.pathname}`;
}

/**
 * Well-known OAuth metadata (RFC 8414 + RFC 9728). Mounted at root `/`,
 * not `/oauth/*`, because discovery clients fetch these at fixed paths.
 *
 * Three protected-resource paths are served on purpose:
 *  - `/.well-known/oauth-protected-resource` — the original bare path. Kept so
 *    clients that already discover us here do not regress; its `resource` stays
 *    the issuer it has always advertised.
 *  - `/.well-known/oauth-protected-resource/mcp` — RFC 9728 path-insertion for
 *    resource `<issuer>/mcp`. This is what the MCP spec tells clients to fetch
 *    and what our 401 now points at.
 *  - `/mcp/.well-known/oauth-protected-resource` — the pre-RFC layout some
 *    clients still try first.
 *
 * Before this existed both spec-shaped paths 404'd, and production logs showed
 * ~280 failed discovery attempts a day split across the two.
 */
export function createOAuthWellKnownRoutes(oauth: OAuthProvider): Hono {
  const app = new Hono();

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauth.getMetadata()));

  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(config.issuer)));

  const mcpResource = rootUrl(config.issuer, "/mcp");
  app.get(MCP_RESOURCE_METADATA_PATH, (c) => c.json(protectedResourceMetadata(mcpResource)));
  app.get("/mcp/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(mcpResource)));

  return app;
}

export function createOAuthRoutes({ oauth, sessions }: OAuthRoutesDeps): Hono {
  const app = new Hono();

  app.use("/*", oauthRateLimit);
  // Small JSON/form bodies only — token/register/revoke payloads are KBs.
  // Caps the parser allocation on these unauthenticated endpoints (audit M1).
  app.use("/*", bodyLimit({ maxSize: config.maxJsonBodyBytes }));

  // RFC 7591 — Dynamic Client Registration. Unauthenticated, so it carries a
  // stricter per-IP limit than the rest of /oauth/* and a hard total-clients
  // ceiling (audit H2).
  app.post("/register", registerRateLimit, async (c) => {
    if (oauth.clientCount() >= config.maxOauthClients && config.maxOauthClients > 0) {
      incr(OAUTH_FLOW, { step: "register", outcome: "capacity" });
      return c.json({ error: "registration temporarily unavailable" }, 503);
    }
    const body = await c.req.json();
    if (!body.redirect_uris || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      incr(OAUTH_FLOW, { step: "register", outcome: "error" });
      return c.json({ error: "redirect_uris required" }, 400);
    }
    if (body.redirect_uris.length > 10) {
      incr(OAUTH_FLOW, { step: "register", outcome: "error" });
      return c.json({ error: "too many redirect_uris" }, 400);
    }
    const client = oauth.registerClient(body);
    incr(OAUTH_FLOW, { step: "register", outcome: "ok" });
    return c.json(client, 201);
  });

  app.get("/authorize", async (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "S256";

    const client = oauth.getClient(clientId);
    if (!client) {
      incr(OAUTH_FLOW, { step: "authorize", outcome: "unknown_client" });
      return c.text("Unknown client", 400);
    }

    const allowedUris = parsedRedirectUris(client.redirect_uris);
    if (!matchRedirectUri(allowedUris, redirectUri)) {
      incr(OAUTH_FLOW, { step: "authorize", outcome: "bad_redirect" });
      return c.text("Invalid redirect_uri", 400);
    }

    // PKCE is mandatory and S256-only (matches advertised metadata). Reject a
    // missing or `plain` challenge here, before any code is minted — `plain`
    // gives no protection if the auth code leaks.
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      incr(OAUTH_FLOW, { step: "authorize", outcome: "bad_pkce" });
      return c.text("PKCE required: code_challenge with code_challenge_method=S256", 400);
    }

    // Fast path: if we have a cookie hint and session is valid, skip QR entirely (HTTP 302).
    //
    // GATED: the silent path runs only for a destination this account has
    // already connected. The cookie is ambient authority — it rides along on an
    // ordinary link click (SameSite=Lax) — so ungated, a stranger who registered
    // a client through open RFC 7591 registration could turn one click into a
    // full authorization code for the victim's Telegram (verified against prod
    // before this fix). Unknown destination ⇒ ask the human first. Returning
    // users see no change: hasGrant() also counts tokens they already hold.
    const userIdHint = getUserIdHint(c);
    const originKey = redirectOrigin(redirectUri);

    if (userIdHint) {
      const telegram = await sessions.tryReconnectSession(userIdHint);
      if (telegram && !(originKey && oauth.hasGrant(userIdHint, originKey))) {
        incr(OAUTH_FLOW, { step: "authorize", outcome: "consent_required" });
        logger.info(`Consent required for ${logUser(userIdHint)}`, {
          component: "oauth",
          event: "oauth.consent.required",
          userId: logUser(userIdHint),
        });
        return c.html(
          <ConsentPage
            clientId={clientId}
            clientName={client.client_name}
            redirectUri={redirectUri}
            redirectOriginKey={originKey ?? redirectUri}
            state={state}
            codeChallenge={codeChallenge}
            codeChallengeMethod={codeChallengeMethod}
          />,
        );
      }
      if (telegram) {
        const code = oauth.createAuthCode({
          clientId,
          userId: userIdHint,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
        });
        const target = buildCodeRedirect(redirectUri, code, state);
        if (!target) return c.text("Invalid redirect_uri", 400);

        logger.info(`Fast OAuth redirect for ${logUser(userIdHint)} (302)`, {
          component: "oauth",
          event: "oauth.fast_redirect",
          userId: logUser(userIdHint),
        });

        incr(OAUTH_FLOW, { step: "authorize", outcome: "fast_redirect" });
        return c.redirect(target, 302);
      }
    }

    incr(OAUTH_FLOW, { step: "authorize", outcome: "qr_page" });

    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("authorize", {
        clientId,
        clientName: client.client_name,
        redirectUri,
        // Where the code will actually be delivered. Shown on the page because
        // scanning the QR IS the consent action, and `client_name` is chosen by
        // whoever registered the client.
        redirectOriginKey: originKey ?? redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        locale,
        scripts: islandScripts("language-switcher", "qr-flow"),
      });
      return c.html(html);
    }

    return c.html(
      <AuthorizePage
        clientId={clientId}
        clientName={client.client_name}
        redirectUri={redirectUri}
        redirectOriginKey={originKey ?? redirectUri}
        state={state}
        codeChallenge={codeChallenge}
        codeChallengeMethod={codeChallengeMethod}
      />,
    );
  });

  app.get("/authorize/qr", async (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "S256";

    const client = oauth.getClient(clientId);
    if (!client) {
      return c.text("Unknown client", 400);
    }

    const allowedUris = parsedRedirectUris(client.redirect_uris);
    if (!matchRedirectUri(allowedUris, redirectUri)) {
      incr(OAUTH_FLOW, { step: "authorize_qr", outcome: "bad_redirect" });
      return c.text("Invalid redirect_uri", 400);
    }

    // PKCE is mandatory and S256-only (see /authorize). Reject before the QR
    // stream so a code is never minted for a no-PKCE / plain flow.
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      incr(OAUTH_FLOW, { step: "authorize_qr", outcome: "bad_pkce" });
      return c.text("PKCE required: code_challenge with code_challenge_method=S256", 400);
    }

    // Same gate as GET /authorize, closing the side door: this stream's
    // session-reuse branch also mints a code from the cookie alone. An
    // ungranted destination drops the hint, so the visitor must actually scan
    // the QR \u2014 a deliberate act \u2014 instead of the code appearing by itself.
    const rawHint = getUserIdHint(c);
    const qrOriginKey = redirectOrigin(redirectUri);
    const userIdHint = rawHint && qrOriginKey && oauth.hasGrant(rawHint, qrOriginKey) ? rawHint : undefined;

    const stream = await handleOAuthQrLogin(
      sessions,
      oauth,
      { clientId, redirectUri, state, codeChallenge, codeChallengeMethod },
      userIdHint,
      c.req.raw.signal,
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  /**
   * Explicit approval of a not-yet-connected destination (the ConsentPage form).
   *
   * Every precondition of GET /authorize is re-checked here rather than trusted
   * from the form: the hidden fields are client-side data, and a user who was
   * shown a page for client A must not be able to submit it for client B.
   *
   * CSRF, three independent layers:
   *   1. POST-only \u2014 no <img>/<link> can trigger it.
   *   2. Origin must equal the issuer \u2014 a cross-site form post is rejected.
   *   3. The tg_user cookie is SameSite=Lax, so it is not even attached to a
   *      cross-site POST; without it there is no session to authorize.
   */
  app.post("/authorize/approve", async (c) => {
    if (c.req.header("origin") !== config.issuer) {
      incr(OAUTH_FLOW, { step: "approve", outcome: "bad_origin" });
      return c.text("Forbidden", 403);
    }

    const form = await c.req.parseBody().catch(() => null);
    const field = (name: string): string => {
      const v = form?.[name];
      return typeof v === "string" ? v : "";
    };
    const clientId = field("client_id");
    const redirectUri = field("redirect_uri");
    const state = field("state");
    const codeChallenge = field("code_challenge");
    const codeChallengeMethod = field("code_challenge_method") || "S256";

    const client = oauth.getClient(clientId);
    if (!client) {
      incr(OAUTH_FLOW, { step: "approve", outcome: "unknown_client" });
      return c.text("Unknown client", 400);
    }
    if (!matchRedirectUri(parsedRedirectUris(client.redirect_uris), redirectUri)) {
      incr(OAUTH_FLOW, { step: "approve", outcome: "bad_redirect" });
      return c.text("Invalid redirect_uri", 400);
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      incr(OAUTH_FLOW, { step: "approve", outcome: "bad_pkce" });
      return c.text("PKCE required: code_challenge with code_challenge_method=S256", 400);
    }

    const userId = getUserIdHint(c);
    if (!userId) {
      incr(OAUTH_FLOW, { step: "approve", outcome: "no_session" });
      return c.text("No active session \u2014 start again from your client", 403);
    }
    // Prove the session is real, exactly like the fast path does. A cookie
    // value alone is a claim, not a credential.
    const telegram = await sessions.tryReconnectSession(userId);
    if (!telegram) {
      incr(OAUTH_FLOW, { step: "approve", outcome: "session_invalid" });
      return c.text("Session expired \u2014 start again from your client", 403);
    }

    const originKey = redirectOrigin(redirectUri);
    if (!originKey) {
      incr(OAUTH_FLOW, { step: "approve", outcome: "bad_redirect" });
      return c.text("Invalid redirect_uri", 400);
    }
    oauth.recordGrant(userId, originKey);

    const code = oauth.createAuthCode({ clientId, userId, redirectUri, codeChallenge, codeChallengeMethod });
    const target = buildCodeRedirect(redirectUri, code, state);
    if (!target) return c.text("Invalid redirect_uri", 400);

    logger.info(`Connection approved by ${logUser(userId)}`, {
      component: "oauth",
      event: "oauth.consent.approved",
      userId: logUser(userId),
      clientId,
    });
    incr(OAUTH_FLOW, { step: "approve", outcome: "ok" });
    return c.redirect(target, 302);
  });

  /**
   * Review code entered on the QR page itself.
   *
   * Directory reviewers cannot scan the QR: they have no phone signed into the
   * demo account. The review LINK (GET /review) covers them only if they open it
   * first, in the same browser that later handles the authorization — and on
   * 2026-09-18 two reviewers started from ChatGPT instead, waited on the QR page
   * four times and rejected the app as "cannot connect to your MCP server". This
   * route puts the way in where they actually get stuck.
   *
   * Entering the code is a deliberate act by the person at this page, for the
   * destination the page names — the same standing as scanning the QR — so it
   * records the grant and returns the code directly instead of detouring through
   * the consent screen.
   *
   * No new authority: the token only selects the one demo session it was issued
   * for, which GET /review already hands to anyone holding it. Every OAuth
   * precondition is re-checked from the form, CSRF is closed by the Origin check
   * (plus SameSite on everything we set), and the review limiter bounds guessing.
   */
  app.post("/authorize/review", reviewRateLimit, async (c) => {
    if (c.req.header("origin") !== config.issuer) {
      incr(OAUTH_FLOW, { step: "review_code", outcome: "bad_origin" });
      return c.text("Forbidden", 403);
    }
    c.header("Cache-Control", "no-store");

    const form = await c.req.parseBody().catch(() => null);
    const field = (name: string): string => {
      const v = form?.[name];
      return typeof v === "string" ? v : "";
    };
    const clientId = field("client_id");
    const redirectUri = field("redirect_uri");
    const state = field("state");
    const codeChallenge = field("code_challenge");
    const codeChallengeMethod = field("code_challenge_method") || "S256";

    const client = oauth.getClient(clientId);
    if (!client) {
      incr(OAUTH_FLOW, { step: "review_code", outcome: "unknown_client" });
      return c.text("Unknown client", 400);
    }
    if (!matchRedirectUri(parsedRedirectUris(client.redirect_uris), redirectUri)) {
      incr(OAUTH_FLOW, { step: "review_code", outcome: "bad_redirect" });
      return c.text("Invalid redirect_uri", 400);
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      incr(OAUTH_FLOW, { step: "review_code", outcome: "bad_pkce" });
      return c.text("PKCE required: code_challenge with code_challenge_method=S256", 400);
    }
    const originKey = redirectOrigin(redirectUri);
    if (!originKey) {
      incr(OAUTH_FLOW, { step: "review_code", outcome: "bad_redirect" });
      return c.text("Invalid redirect_uri", 400);
    }

    const token = extractReviewToken(field("review_code"));
    const resolved = token ? sessions.resolveReviewToken(token) : null;
    if (!resolved) {
      // Same answer for malformed, unknown, revoked and expired (see GET /review).
      incr(OAUTH_FLOW, { step: "review_code", outcome: "rejected" });
      logger.warn("Review code rejected", { component: "review", event: "review.code.rejected" });
      return c.html(
        reviewPage(
          "This review code is not valid",
          "The code is unknown, expired or has been revoked. Go back, check the code from the test instructions and try again.",
        ),
        403,
      );
    }

    const telegram = await sessions.tryReconnectSession(resolved.userId);
    if (!telegram) {
      incr(OAUTH_FLOW, { step: "review_code", outcome: "session_unavailable" });
      logger.error("Review code resolved but its session is not connected", {
        component: "review",
        event: "review.session.unavailable",
        userId: logUser(resolved.userId),
      });
      return c.html(
        reviewPage(
          "The demo account is temporarily offline",
          "The code is valid, but its Telegram session needs to be restored. Please contact us and we will restore it.",
        ),
        503,
      );
    }

    oauth.recordGrant(resolved.userId, originKey);
    const code = oauth.createAuthCode({
      clientId,
      userId: resolved.userId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
    });
    const target = buildCodeRedirect(redirectUri, code, state);
    if (!target) return c.text("Invalid redirect_uri", 400);

    logger.info("Review code used", {
      component: "review",
      event: "review.code.used",
      userId: logUser(resolved.userId),
      uses: resolved.uses,
      clientId,
    });
    incr(OAUTH_FLOW, { step: "review_code", outcome: "ok" });
    // Same hint GET /review writes, so a client that re-authorizes later (token
    // lost, connector re-added) passes through the fast path instead of landing
    // on the QR page again.
    c.header("Set-Cookie", buildTgUserCookie(resolved.userId, REVIEW_HINT_MAX_AGE_SECONDS));
    return c.redirect(target, 302);
  });

  // Server-side setter for the `tg_user` hint cookie. Called from the
  // AuthorizePage client script after a successful QR login so the cookie can
  // be HttpOnly (the previous client-side `document.cookie = …` set the same
  // value but made it readable from JS, which an XSS could exfiltrate).
  // CSRF protection: same-origin via Origin header check against config.issuer.
  app.post("/authorize/qr/cookie", async (c) => {
    const result = decideTgUserCookie({
      origin: c.req.header("origin"),
      issuer: config.issuer,
      body: await c.req
        .json()
        .then((b) => b as { username?: unknown })
        .catch(() => null),
    });
    if (result.status === 204) {
      c.header("Set-Cookie", result.setCookie);
      return c.body(null, 204);
    }
    return c.text(result.body, result.status);
  });

  app.post("/token", async (c) => {
    const params = await parseTokenParams(c);

    if (params.grant_type === "authorization_code") {
      const result = oauth.exchangeCode({
        code: params.code ?? "",
        clientId: params.client_id ?? "",
        codeVerifier: params.code_verifier ?? "",
        redirectUri: params.redirect_uri ?? "",
      });

      if (!result) {
        incr(OAUTH_FLOW, { step: "token", outcome: "invalid_grant" });
        return c.json({ error: "invalid_grant" }, 400);
      }

      incr(OAUTH_FLOW, { step: "token", outcome: "ok" });
      return c.json(result);
    }

    if (params.grant_type === "refresh_token") {
      const result = oauth.refreshAccessToken({
        refreshToken: params.refresh_token ?? "",
        clientId: params.client_id ?? "",
      });

      if (!result) {
        incr(OAUTH_FLOW, { step: "refresh", outcome: "invalid_grant" });
        return c.json({ error: "invalid_grant" }, 400);
      }

      incr(OAUTH_FLOW, { step: "refresh", outcome: "ok" });
      return c.json(result);
    }

    incr(OAUTH_FLOW, { step: "token", outcome: "unsupported_grant" });
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  // RFC 7009 — Token Revocation
  app.post("/revoke", async (c) => {
    const params = await parseTokenParams(c);
    const token = params.token;
    logger.info(`Revocation request received`, { component: "oauth", event: "oauth.revoke.start" });

    if (!token) {
      logger.info(`No token provided, returning 200 per RFC 7009`, {
        component: "oauth",
        event: "oauth.revoke.empty",
      });
      return c.json({});
    }

    const userId = oauth.revokeToken(token);

    if (userId) {
      const uid = logUser(userId);
      logger.info(`Destroying Telegram session for ${uid}`, {
        component: "oauth",
        userId: uid,
        event: "oauth.revoke.cleanup",
      });
      const { loggedOut } = await sessions.destroyUserSession(userId);
      oauth.revokeAllUserTokens(userId);
      logger.info(`Full cleanup done for ${uid} (loggedOut=${loggedOut})`, {
        component: "oauth",
        userId: uid,
        event: "oauth.revoke.done",
      });
      incr(OAUTH_FLOW, { step: "revoke", outcome: "ok" });
    } else {
      logger.info(`Token not found or already expired`, { component: "oauth", event: "oauth.revoke.notfound" });
      incr(OAUTH_FLOW, { step: "revoke", outcome: "notfound" });
    }

    // RFC 7009: always return 200, even if token was invalid
    return c.json({});
  });

  return app;
}
