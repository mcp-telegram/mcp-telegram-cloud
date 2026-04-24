import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { TELEGRAM_ICON_SVG } from "./icon.js";
import { logger, logUser } from "./logger.js";
import { handleMcpRequest } from "./mcp-handler.js";
import { OAuthProvider } from "./oauth.js";
import { AuthorizePage } from "./pages/AuthorizePage.js";
import { LandingPage } from "./pages/LandingPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";
import { TermsPage } from "./pages/TermsPage.js";
import { handleOAuthQrLogin, handleQrLogin } from "./qr-login.js";
import { SessionManager } from "./session-manager.js";
import { UsageTracker } from "./usage.js";

const app = new Hono();
const sessions = new SessionManager();

const oauth = new OAuthProvider({ issuer: config.issuer, db: sessions.getDb() });
const usage = new UsageTracker(sessions.getDb());

/** Constant-time comparison of admin Bearer token to prevent timing attacks. */
function isAdminAuthorized(authHeader: string | undefined): boolean {
  if (!config.adminToken || !authHeader) return false;
  const expected = `Bearer ${config.adminToken}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Periodic cleanup of expired OAuth codes/tokens
setInterval(() => oauth.cleanup(), 3600_000);

// Periodic purge of old usage_log rows (retention policy)
if (config.usageLogRetentionDays > 0) {
  setInterval(() => {
    const removed = usage.purgeOldLogs(config.usageLogRetentionDays);
    if (removed > 0) {
      logger.info(`Purged ${removed} old usage_log rows`, {
        component: "usage",
        event: "retention.purge",
        removed,
        retentionDays: config.usageLogRetentionDays,
      });
    }
  }, 24 * 3600_000);
}

// ─── Access Log ──────────────────────────────────────────────────────
/** Classify user-agent into safe category — no raw UA string in logs */
function classifyClient(ua: string): string {
  const l = ua.toLowerCase();
  if (l.includes("chatgpt") || l.includes("openai")) return "chatgpt";
  if (l.includes("claude") || l.includes("anthropic")) return "claude";
  if (l.includes("bot") || l.includes("spider") || l.includes("crawler") || l.includes("scan")) return "bot";
  if (l.includes("mozilla") || l.includes("chrome") || l.includes("safari") || l.includes("firefox")) return "browser";
  if (l.includes("node") || l.includes("python") || l.includes("curl") || l.includes("fetch")) return "script";
  if (!l) return "empty";
  return "other";
}

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  const method = c.req.method;
  const path = c.req.path;

  // Skip noisy health checks and static assets
  if (path === "/health" || path === "/icon.svg") return;

  const client = classifyClient(c.req.header("user-agent") ?? "");
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  logger[level](`${method} ${path} ${status} ${duration}ms [${client}]`, {
    component: "http",
    event: "http.request",
    method,
    path,
    status: String(status),
    durationMs: duration,
    client,
  });
});

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

// ─── Landing ─────────────────────────────────────────────────────────
app.get("/", (c) => c.html(<LandingPage />));
app.get("/privacy", (c) => c.html(<PrivacyPage />));
app.get("/terms", (c) => c.html(<TermsPage />));

// ─── OpenAI Apps Domain Verification ─────────────────────────────────
// Served only if OPENAI_APPS_CHALLENGE is configured — silent 404 otherwise.
app.get("/.well-known/openai-apps-challenge", (c) =>
  config.openaiAppsChallenge ? c.text(config.openaiAppsChallenge) : c.notFound(),
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

// ─── OAuth 2.0 Protected Resource Metadata (RFC 9728) ───────────────
app.get("/.well-known/oauth-protected-resource", (c) => {
  return c.json({
    resource: config.issuer,
    authorization_servers: [config.issuer],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
  });
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
app.get("/oauth/authorize", async (c) => {
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

  // Fast path: if we have a cookie hint and session is valid, skip QR entirely (HTTP 302)
  const cookies = c.req.header("cookie") ?? "";
  const tgUserMatch = cookies.match(/tg_user=([^;]+)/);
  const userIdHint = tgUserMatch ? decodeURIComponent(tgUserMatch[1]) : undefined;

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

// ─── OAuth QR Login SSE (used by authorize page) ─────────────────────
app.get("/oauth/authorize/qr", async (c) => {
  const clientId = c.req.query("client_id") ?? "";
  const redirectUri = c.req.query("redirect_uri") ?? "";
  const state = c.req.query("state") ?? "";
  const codeChallenge = c.req.query("code_challenge") ?? "";
  const codeChallengeMethod = c.req.query("code_challenge_method") ?? "S256";

  const client = oauth.getClient(clientId);
  if (!client) {
    return c.text("Unknown client", 400);
  }

  // Read userId hint from cookie (set after first successful QR login)
  const cookies = c.req.header("cookie") ?? "";
  const tgUserMatch = cookies.match(/tg_user=([^;]+)/);
  const userIdHint = tgUserMatch ? decodeURIComponent(tgUserMatch[1]) : undefined;

  const controller = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => controller.abort());

  const stream = await handleOAuthQrLogin(
    sessions,
    oauth,
    { clientId, redirectUri, state, codeChallenge, codeChallengeMethod },
    userIdHint,
    controller.signal,
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
  logger.info(`Revocation request received`, { component: "oauth", event: "oauth.revoke.start" });

  if (!token) {
    logger.info(`No token provided, returning 200 per RFC 7009`, { component: "oauth", event: "oauth.revoke.empty" });
    return c.json({});
  }

  // Revoke the OAuth token and get user_id
  const userId = oauth.revokeToken(token);

  if (userId) {
    const uid = logUser(userId);
    logger.info(`Destroying Telegram session for ${uid}`, {
      component: "oauth",
      userId: uid,
      event: "oauth.revoke.cleanup",
    });
    // Full cleanup: logout from Telegram + delete session from SQLite
    const { loggedOut } = await sessions.destroyUserSession(userId);
    // Also revoke any other tokens for this user
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

// ─── Usage Stats API (admin) ─────────────────────────────────────────
app.get("/api/stats", (c) => {
  if (!isAdminAuthorized(c.req.header("Authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const days = Number(c.req.query("days") ?? 30);
  const userId = c.req.query("user_id");
  return c.json({
    daily: usage.getDailyStats(days),
    users: usage.getUserStats(days),
    clients: usage.getClientStats(days),
    dau: usage.getDailyActiveUsers(days),
    peakHours: usage.getHourlyStats(days),
    ...(userId ? { tools: usage.getToolBreakdown(userId, days) } : {}),
  });
});

// ─── Session Import API ──────────────────────────────────────────────
app.post("/api/import-session", async (c) => {
  const auth = c.req.header("Authorization");

  // Require admin token or Bearer token
  let userId: string | null = null;

  if (isAdminAuthorized(auth)) {
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
    const tokenInfo = oauth.validateToken(auth.slice(7));
    if (tokenInfo) userId = tokenInfo.userId;
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
  // Extract userId + clientName from Bearer token (OAuth 2.0) or fallback to X-User-Id (dev)
  let userId: string | null = null;
  let clientName = "";

  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const tokenInfo = oauth.validateToken(auth.slice(7));
    if (tokenInfo) {
      userId = tokenInfo.userId;
      clientName = tokenInfo.clientName;
    }
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

  return handleMcpRequest(sessions, usage, oauth, userId, clientName, c.req.raw);
});

// ─── QR Login ────────────────────────────────────────────────────────
app.get("/login", (c) => {
  return c.html(<LoginPage />);
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
logger.info(`${config.brandName} starting on port ${config.port}`, {
  component: "cloud",
  event: "server.start",
  issuer: config.issuer,
});
serve({ fetch: app.fetch, port: config.port });

// ─── Graceful shutdown ──────────────────────────────────────────────
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    logger.info(`Received ${sig}, shutting down`, { component: "cloud", event: "server.stop" });
    await logger.flush();
    process.exit(0);
  });
}
