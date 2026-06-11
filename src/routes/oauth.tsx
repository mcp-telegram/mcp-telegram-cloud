import type { Context } from "hono";
import { Hono } from "hono";
import { config } from "../config.js";
import { decideTgUserCookie } from "../cookie-handler.js";
import { logger, logUser } from "../logger.js";
import type { OAuthProvider } from "../oauth.js";
import { AuthorizePage } from "../pages/AuthorizePage.js";
import { handleOAuthQrLogin } from "../qr-login.js";
import { oauthRateLimit } from "../rate-limit.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import { matchRedirectUri } from "../redirect-uri-matcher.js";
import type { SessionManager } from "../session-manager.js";
import { incr, OAUTH_FLOW } from "../telemetry/metrics.js";

export interface OAuthRoutesDeps {
  oauth: OAuthProvider;
  sessions: SessionManager;
}

function getUserIdHint(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/tg_user=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
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
 * Well-known OAuth metadata (RFC 8414 + RFC 9728). Mounted at root `/`,
 * not `/oauth/*`, because discovery clients fetch these at fixed paths.
 */
export function createOAuthWellKnownRoutes(oauth: OAuthProvider): Hono {
  const app = new Hono();

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauth.getMetadata()));

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: config.issuer,
      authorization_servers: [config.issuer],
      scopes_supported: ["mcp:read"],
      bearer_methods_supported: ["header"],
    }),
  );

  return app;
}

export function createOAuthRoutes({ oauth, sessions }: OAuthRoutesDeps): Hono {
  const app = new Hono();

  app.use("/*", oauthRateLimit);

  // RFC 7591 — Dynamic Client Registration
  app.post("/register", async (c) => {
    const body = await c.req.json();
    if (!body.redirect_uris || !Array.isArray(body.redirect_uris)) {
      incr(OAUTH_FLOW, { step: "register", outcome: "error" });
      return c.json({ error: "redirect_uris required" }, 400);
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

    const allowedUris: string[] = JSON.parse(client.redirect_uris);
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

    // Fast path: if we have a cookie hint and session is valid, skip QR entirely (HTTP 302)
    const userIdHint = getUserIdHint(c);

    if (userIdHint) {
      const telegram = await sessions.tryReconnectSession(userIdHint);
      if (telegram) {
        const code = oauth.createAuthCode({
          clientId,
          userId: userIdHint,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
        });
        const url = new URL(redirectUri);
        url.searchParams.set("code", code);
        if (state) url.searchParams.set("state", state);

        logger.info(`Fast OAuth redirect for ${logUser(userIdHint)} (302)`, {
          component: "oauth",
          event: "oauth.fast_redirect",
          userId: logUser(userIdHint),
        });

        incr(OAUTH_FLOW, { step: "authorize", outcome: "fast_redirect" });
        return c.redirect(url.toString(), 302);
      }
    }

    incr(OAUTH_FLOW, { step: "authorize", outcome: "qr_page" });

    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("authorize", {
        clientId,
        clientName: client.client_name,
        redirectUri,
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

    const allowedUris: string[] = JSON.parse(client.redirect_uris);
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

    const userIdHint = getUserIdHint(c);

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
