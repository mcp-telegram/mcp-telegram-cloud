import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { config, iconPng256Url, iconPngUrl, iconUrl } from "./config.js";
import { type DestructiveGuard, summarizeArgs } from "./destructive-guard.js";
import { logger, logUser } from "./logger.js";
import type { OAuthProvider } from "./oauth.js";
import type { SessionManager } from "./session-manager.js";
import { registerAllAllowedTools } from "./tools.js";
import type { UploadStore } from "./upload-store.js";
import { fetchUrlSafely } from "./url-fetcher.js";
import type { UsageTracker } from "./usage.js";

/** Map of MCP session ID → transport (for multi-request sessions) */
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

/** Map of MCP session ID → userId (to track which user owns which session) */
const sessionOwners = new Map<string, string>();

/** Count of active MCP sessions per userId */
const activeSessionCount = new Map<string, number>();

/** Pending cleanup timers per userId — cancelled if user reconnects */
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** How long to wait after last MCP session closes before destroying Telegram session */
const CLEANUP_DELAY_MS = config.sessionCleanupDelayMinutes * 60 * 1000;

/**
 * Create or retrieve an MCP transport for the given request.
 * Each MCP session gets its own McpServer + Transport pair wired to the user's TelegramService.
 */
export async function handleMcpRequest(
  sessions: SessionManager,
  usage: UsageTracker,
  oauth: OAuthProvider,
  destructive: DestructiveGuard,
  uploads: UploadStore,
  userId: string,
  clientName: string,
  req: Request,
): Promise<Response> {
  // Check for existing session via header
  const sessionId = req.headers.get("mcp-session-id");

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    if (transport) return transport.handleRequest(req);
  }

  // User reconnected — cancel any pending cleanup
  const pendingCleanup = cleanupTimers.get(userId);
  if (pendingCleanup) {
    clearTimeout(pendingCleanup);
    cleanupTimers.delete(userId);
    logger.info(`Cleanup timer cancelled (reconnected)`, {
      component: "cloud",
      userId: logUser(userId),
      event: "cleanup.cancelled",
    });
  }

  // New session — create MCP server + transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      sessionOwners.set(sid, userId);
      activeSessionCount.set(userId, (activeSessionCount.get(userId) ?? 0) + 1);
      logger.info(`MCP session started: ${sid}`, {
        component: "cloud",
        userId: logUser(userId),
        event: "session.start",
        sessionId: sid,
        active: activeSessionCount.get(userId),
      });
    },
    onsessionclosed: (sid) => {
      transports.delete(sid);
      sessionOwners.delete(sid);

      const remaining = (activeSessionCount.get(userId) ?? 1) - 1;
      activeSessionCount.set(userId, remaining);
      logger.info(`MCP session closed: ${sid}`, {
        component: "cloud",
        userId: logUser(userId),
        event: "session.close",
        sessionId: sid,
        remaining,
      });

      // Only disconnect Telegram when the LAST MCP session for this user closes
      if (remaining > 0) return;

      activeSessionCount.delete(userId);

      // Immediately disconnect Telegram client to stop GramJS update loop (no more TIMEOUT spam)
      // Session string is already saved in SQLite — reconnect will restore from it
      sessions.disconnectUser(userId);

      // Schedule full cleanup — if user doesn't reconnect within CLEANUP_DELAY_MS, destroy session
      const timer = setTimeout(async () => {
        cleanupTimers.delete(userId);
        logger.info(`Cleanup timer fired, destroying session`, {
          component: "cloud",
          userId: logUser(userId),
          event: "cleanup.fired",
        });
        await sessions.destroyUserSession(userId);
      }, CLEANUP_DELAY_MS);

      cleanupTimers.set(userId, timer);
      logger.info(`Cleanup timer set (${CLEANUP_DELAY_MS / 60000}m)`, {
        component: "cloud",
        userId: logUser(userId),
        event: "cleanup.scheduled",
      });
    },
  });

  const server = new McpServer({
    name: config.logServiceName,
    version: "0.1.0",
    // PNG listed first because ChatGPT (as of 2026-04) does not appear to consume
    // the SVG variant in its connector avatar — Apps Directory submission requires
    // a 128×128 PNG. The SVG remains as a high-quality fallback for clients that
    // do prefer scalable graphics.
    icons: [
      { src: iconPngUrl, mimeType: "image/png", sizes: ["128x128"] },
      { src: iconPng256Url, mimeType: "image/png", sizes: ["256x256"] },
      { src: iconUrl, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  });

  await sessions.getOrCreateSession(userId);

  // Dynamic lookup: always get the CURRENT telegram instance from the pool
  // This prevents stale references when adoptSession replaces the instance after QR re-login
  const getTelegram = () => {
    const current = sessions.getSession(userId);
    if (!current) throw new Error("No Telegram session — please reconnect");
    return current;
  };

  const requireConnection = async (): Promise<string | null> => {
    try {
      const telegram = getTelegram();
      if (await telegram.ensureConnected()) return null;
      const reason = telegram.lastError ? ` ${telegram.lastError}` : "";
      return `Not connected to Telegram.${reason}`;
    } catch {
      return "Not connected to Telegram. Session not found — please reconnect.";
    }
  };

  const onSessionRevoked = async () => {
    const uid = logUser(userId);
    logger.warn(`Session revoked, cleaning up`, { component: "cloud", userId: uid, event: "session.revoked" }); // telemetry-allow: uid = logUser(userId) hashed above
    await sessions.destroyUserSession(userId);
    // Invalidate all OAuth tokens → ChatGPT gets 401 → refresh fails → triggers re-auth → QR
    const revoked = oauth.revokeAllUserTokens(userId);
    logger.info(`OAuth tokens invalidated after session revoke: ${revoked}`, {
      component: "oauth",
      userId: uid,
      event: "oauth.token.revoke_on_session_death",
    });
  };

  const FREE_TIER_LIMIT = config.freeTierLimit;

  const onToolCall = (toolName: string) => {
    usage.logToolCall(userId, toolName, clientName);
    logger.info(`Tool call: ${toolName}`, {
      component: "tools",
      userId: logUser(userId),
      client: clientName,
      event: "tool.call",
      tool: toolName,
    });
  };

  const checkRateLimit = (toolName: string): string | null => {
    if (FREE_TIER_LIMIT <= 0) return null; // 0 = unlimited
    const todayCount = usage.getTodayCount(userId);
    if (todayCount >= FREE_TIER_LIMIT) {
      logger.warn(`Rate limit hit: ${todayCount}/${FREE_TIER_LIMIT}`, {
        component: "tools",
        userId: logUser(userId),
        event: "rate_limit.hit",
        tool: toolName,
        count: todayCount,
      });
      const base = `Daily limit reached (${todayCount}/${FREE_TIER_LIMIT} calls today).`;
      // The hosted instance has a fair-use cap; self-hosters lift it via FREE_TIER_LIMIT.
      // No paid tier — both messages point at self-host as the unlimited path.
      return `${base} For unlimited usage, self-host the open source server: ${config.sourceRepoUrl}`;
    }
    return null;
  };

  // Cache args summary once per (toolName, args) pair so checkDestructive's
  // pre-handler write and recordDestructive's post-handler write share the
  // exact same audit string — avoids subtle drift if args mutate, and one
  // less call to summarizeArgs per destructive call.
  const lastSummary = new WeakMap<object, string>();
  const summaryFor = (args: unknown): string => {
    if (!args || typeof args !== "object") return "";
    const obj = args as object;
    const cached = lastSummary.get(obj);
    if (cached !== undefined) return cached;
    const s = summarizeArgs(args);
    lastSummary.set(obj, s);
    return s;
  };

  const checkDestructive = (toolName: string, args: unknown): string | null => {
    const summary = summaryFor(args);
    const err = destructive.preflight(userId, toolName, summary);
    if (err) {
      logger.warn(`Destructive denied: ${toolName}`, {
        component: "tools",
        userId: logUser(userId),
        event: "destructive.denied",
        tool: toolName,
        // The first sentence of the message classifies the deny reason
        // (Destructive tools are disabled / Daily destructive-action limit reached).
        reason: err.split(".")[0],
      });
    }
    return err;
  };

  const recordDestructive = (toolName: string, args: unknown, result: "ok" | "error"): void => {
    destructive.recordResult(userId, toolName, summaryFor(args), result);
  };

  registerAllAllowedTools(
    server,
    getTelegram,
    requireConnection,
    onSessionRevoked,
    onToolCall,
    checkRateLimit,
    checkDestructive,
    recordDestructive,
    { userId, uploads, fetchUrl: fetchUrlSafely },
  );

  await server.connect(transport);
  return transport.handleRequest(req);
}
