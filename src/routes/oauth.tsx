import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isAdminSessionValid } from "../auth/admin.js";
import { config } from "../config.js";
import { decideTgUserCookie } from "../cookie-handler.js";
import { logger, logUser } from "../logger.js";
import type { OAuthProvider } from "../oauth.js";
import { AuthorizePage } from "../pages/AuthorizePage.js";
import { handleOAuthQrLogin } from "../qr-login.js";
import { oauthRateLimit, registerRateLimit } from "../rate-limit.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import { matchRedirectUri } from "../redirect-uri-matcher.js";
import type { SessionManager } from "../session-manager.js";
import { incr, OAUTH_FLOW } from "../telemetry/metrics.js";

export interface OAuthRoutesDeps {
  oauth: OAuthProvider;
  sessions: SessionManager;
}

async function parseTokenParams(c: Context): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.formData();
    return Object.fromEntries(form.entries()) as Record<string, string>;
  }
  return c.req.json();
}

function getUserIdHint(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/tg_user=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
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

    if (config.singleOperatorMode) {
      if (!isAdminSessionValid(c.req.header("cookie"))) {
        const returnTo = `${c.req.path}?${new URL(c.req.url).search.slice(1)}`;
        incr(OAUTH_FLOW, { step: "authorize", outcome: "admin_login_required" });
        return c.redirect(`/admin-login?returnTo=${encodeURIComponent(returnTo)}`, 302);
      }

      // Admin is authenticated. Fast path: if the deployment's one Telegram
      // account is already connected, skip the QR page entirely.
      const telegram = await sessions.tryReconnectSession(config.ownerUserId);
      if (telegram) {
        const code = oauth.createAuthCode({
          clientId,
          userId: config.ownerUserId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
        });
        const url = new URL(redirectUri);
        url.searchParams.set("code", code);
        if (state) url.searchParams.set("state", state);

        logger.info(`Fast OAuth redirect for ${logUser(config.ownerUserId)} (302)`, {
          component: "oauth",
          event: "oauth.fast_redirect",
          userId: logUser(config.ownerUserId),
        });

        incr(OAUTH_FLOW, { step: "authorize", outcome: "fast_redirect" });
        return c.redirect(url.toString(), 302);
      }
    } else {
      // Upstream's original multi-tenant fast path: an optional per-visitor
      // hint cookie (set after a prior QR login) lets a returning visitor skip
      // the QR page if their session is still valid. No admin gate — anyone
      // can reach this far, exactly like upstream.
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

    let userIdHint: string | undefined;
    if (config.singleOperatorMode) {
      if (!isAdminSessionValid(c.req.header("cookie"))) {
        return c.text("Forbidden", 403);
      }
      userIdHint = config.ownerUserId;
    } else {
      userIdHint = getUserIdHint(c);
    }

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

  // RFC 7009 — Token Revocation. Scoped to exactly the token presented: this
  // deployment can have multiple OAuth clients (e.g. Claude.ai + ChatGPT)
  // sharing one identity, so revoking must NOT cascade into every other
  // client's tokens — that cascade is a bug in BOTH modes and stays fixed
  // unconditionally below.
  //
  // Whether it ALSO tears down the Telegram session depends on the mode:
  //  - Multi-tenant (default, flag off): one Telegram identity IS one user
  //    (no sharing across OAuth clients the way `config.ownerUserId` is
  //    shared in single-operator mode), so this token revoke is that user's
  //    only self-service disconnect — `/my/*` has no disconnect route, and
  //    `/api/disconnect-telegram` is admin-only and hardwired to
  //    `config.ownerUserId`. Matches upstream's original behavior.
  //  - Single-operator mode (flag on): multiple OAuth clients share one
  //    fixed owner id, so a full teardown here would log out every other
  //    client too. Skip it — use the admin panel's explicit "Disconnect
  //    Telegram" action instead (routes/admin.tsx).
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
      if (!config.singleOperatorMode) {
        await sessions.destroyUserSession(userId);
        logger.info(`Telegram session destroyed for ${logUser(userId)}`, {
          component: "oauth",
          userId: logUser(userId),
          event: "oauth.revoke.telegram_logout",
        });
      }
      logger.info(`Token revoked for ${logUser(userId)}`, {
        component: "oauth",
        userId: logUser(userId),
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
