import type { Context } from "hono";
import { Hono } from "hono";
import { config } from "../config.js";
import { logger, logUser } from "../logger.js";
import type { OAuthProvider } from "../oauth.js";
import { AuthorizePage } from "../pages/AuthorizePage.js";
import { handleOAuthQrLogin } from "../qr-login.js";
import { oauthRateLimit } from "../rate-limit.js";
import type { SessionManager } from "../session-manager.js";

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
      return c.json({ error: "redirect_uris required" }, 400);
    }
    const client = oauth.registerClient(body);
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
      return c.text("Unknown client", 400);
    }

    const allowedUris: string[] = JSON.parse(client.redirect_uris);
    if (!allowedUris.includes(redirectUri)) {
      return c.text("Invalid redirect_uri", 400);
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

        return c.redirect(url.toString(), 302);
      }
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
        return c.json({ error: "invalid_grant" }, 400);
      }

      return c.json(result);
    }

    if (params.grant_type === "refresh_token") {
      const result = oauth.refreshAccessToken({
        refreshToken: params.refresh_token ?? "",
        clientId: params.client_id ?? "",
      });

      if (!result) {
        return c.json({ error: "invalid_grant" }, 400);
      }

      return c.json(result);
    }

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
    } else {
      logger.info(`Token not found or already expired`, { component: "oauth", event: "oauth.revoke.notfound" });
    }

    // RFC 7009: always return 200, even if token was invalid
    return c.json({});
  });

  return app;
}
