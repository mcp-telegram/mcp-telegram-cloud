import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { TELEGRAM_ICON_SVG } from "./icon.js";
import { handleMcpRequest } from "./mcp-handler.js";
import { OAuthProvider, renderAuthorizePage } from "./oauth.js";
import { handleQrLogin, renderLoginPage } from "./qr-login.js";
import { SessionManager } from "./session-manager.js";

const app = new Hono();
const sessions = new SessionManager();

const ISSUER = process.env.ISSUER || "https://mcp-telegram.com";
const PORT = Number(process.env.PORT) || 3000;

const oauth = new OAuthProvider({ issuer: ISSUER, db: sessions.getDb() });

// Periodic cleanup of expired OAuth codes/tokens
setInterval(() => oauth.cleanup(), 3600_000);

// ─── CORS ────────────────────────────────────────────────────────────
app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  }),
);

// ─── Health ──────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    status: "ok",
    activeSessions: sessions.getActiveCount(),
  }),
);

// ─── Icon ────────────────────────────────────────────────────────────
app.get("/icon.svg", (c) => {
  return c.body(TELEGRAM_ICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ─── OAuth 2.0 Discovery (RFC 8414) ─────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (c) => {
  return c.json(oauth.getMetadata());
});

// ─── OAuth 2.0 Dynamic Client Registration (RFC 7591) ────────────────
app.post("/oauth/register", async (c) => {
  const body = await c.req.json();
  if (!body.redirect_uris || !Array.isArray(body.redirect_uris)) {
    return c.json({ error: "redirect_uris required" }, 400);
  }
  const client = oauth.registerClient(body);
  return c.json(client, 201);
});

// ─── OAuth 2.0 Authorization Endpoint ────────────────────────────────
app.get("/oauth/authorize", (c) => {
  const clientId = c.req.query("client_id") ?? "";
  const redirectUri = c.req.query("redirect_uri") ?? "";
  const state = c.req.query("state") ?? "";
  const codeChallenge = c.req.query("code_challenge") ?? "";
  const codeChallengeMethod = c.req.query("code_challenge_method") ?? "S256";

  const client = oauth.getClient(clientId);
  if (!client) {
    return c.text("Unknown client", 400);
  }

  // Validate redirect_uri
  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirectUri)) {
    return c.text("Invalid redirect_uri", 400);
  }

  return c.html(
    renderAuthorizePage({
      clientId,
      clientName: client.client_name,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
    }),
  );
});

app.post("/oauth/authorize", async (c) => {
  const form = await c.req.formData();
  const clientId = form.get("client_id") as string;
  const redirectUri = form.get("redirect_uri") as string;
  const state = form.get("state") as string;
  const codeChallenge = form.get("code_challenge") as string;
  const codeChallengeMethod = (form.get("code_challenge_method") as string) || "S256";
  const username = form.get("username") as string;

  if (!username) {
    const client = oauth.getClient(clientId);
    return c.html(
      renderAuthorizePage({
        clientId,
        clientName: client?.client_name ?? "",
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        error: "Username is required",
      }),
    );
  }

  const code = oauth.createAuthCode({
    clientId,
    userId: username,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
  });

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  return c.redirect(url.toString());
});

// ─── OAuth 2.0 Token Endpoint ────────────────────────────────────────
app.post("/oauth/token", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let params: Record<string, string>;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.formData();
    params = Object.fromEntries(form.entries()) as Record<string, string>;
  } else {
    params = await c.req.json();
  }

  if (params.grant_type !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }

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
});

// ─── OAuth 2.0 Token Revocation (RFC 7009) ──────────────────────────
app.post("/oauth/revoke", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let params: Record<string, string>;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.formData();
    params = Object.fromEntries(form.entries()) as Record<string, string>;
  } else {
    params = await c.req.json();
  }

  const token = params.token;
  console.log(`[revoke] Received revocation request`, {
    hasToken: !!token,
    tokenHint: params.token_type_hint,
    headers: Object.fromEntries(
      [...c.req.raw.headers.entries()].filter(([k]) => !k.toLowerCase().includes("authorization")),
    ),
  });

  if (!token) {
    console.log("[revoke] No token provided, returning 200 per RFC 7009");
    return c.json({});
  }

  // Revoke the OAuth token and get user_id
  const userId = oauth.revokeToken(token);

  if (userId) {
    console.log(`[revoke] Token revoked for user ${userId}, destroying Telegram session...`);
    // Full cleanup: logout from Telegram + delete session from SQLite
    const { loggedOut } = await sessions.destroyUserSession(userId);
    // Also revoke any other tokens for this user
    oauth.revokeAllUserTokens(userId);
    console.log(`[revoke] Full cleanup done for ${userId} (telegramLogOut=${loggedOut})`);
  } else {
    console.log("[revoke] Token not found or already expired");
  }

  // RFC 7009: always return 200, even if token was invalid
  return c.json({});
});

// ─── Session Import API ──────────────────────────────────────────────
app.post("/api/import-session", async (c) => {
  const auth = c.req.header("Authorization");
  const adminToken = process.env.ADMIN_TOKEN;

  // Require admin token or Bearer token
  let userId: string | null = null;

  if (adminToken && auth === `Bearer ${adminToken}`) {
    // Admin can import for any user
    const body = await c.req.json();
    userId = body.userId;
    if (!userId) return c.json({ error: "userId required" }, 400);

    const sessionString = body.sessionString;
    if (!sessionString) return c.json({ error: "sessionString required" }, 400);

    sessions.saveSessionString(userId, sessionString);
    return c.json({ ok: true, userId });
  }

  if (auth?.startsWith("Bearer ")) {
    userId = oauth.validateToken(auth.slice(7));
  }

  if (!userId) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json();
  const sessionString = body.sessionString;
  if (!sessionString) return c.json({ error: "sessionString required" }, 400);

  sessions.saveSessionString(userId, sessionString);
  return c.json({ ok: true, userId });
});

// ─── MCP Endpoint ────────────────────────────────────────────────────
app.all("/mcp", async (c) => {
  // Extract userId from Bearer token (OAuth 2.0) or fallback to X-User-Id (dev)
  let userId: string | null = null;

  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    userId = oauth.validateToken(auth.slice(7));
  }

  // Fallback for dev/testing
  if (!userId) {
    userId = c.req.header("X-User-Id") || null;
  }

  if (!userId) {
    return c.json(
      {
        error: "unauthorized",
        message: "Bearer token required. Use OAuth 2.0 flow to authenticate.",
      },
      401,
    );
  }

  return handleMcpRequest(sessions, userId, c.req.raw);
});

// ─── QR Login ────────────────────────────────────────────────────────
app.get("/login", (c) => {
  return c.html(renderLoginPage());
});

app.get("/login/qr", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.text("userId required", 400);
  }

  const controller = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => controller.abort());

  const stream = await handleQrLogin(sessions, userId, controller.signal);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ─── Start ───────────────────────────────────────────────────────────
console.log(`[cloud] MCP Telegram Cloud starting on port ${PORT}`);
console.log(`[cloud] Issuer: ${ISSUER}`);
serve({ fetch: app.fetch, port: PORT });
