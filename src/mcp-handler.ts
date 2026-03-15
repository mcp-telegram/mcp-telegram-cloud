import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { logger } from "./logger.js";
import type { SessionManager } from "./session-manager.js";
import { registerReadOnlyTools } from "./tools.js";
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
const CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create or retrieve an MCP transport for the given request.
 * Each MCP session gets its own McpServer + Transport pair wired to the user's TelegramService.
 */
export async function handleMcpRequest(
  sessions: SessionManager,
  usage: UsageTracker,
  userId: string,
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
    logger.info(`Cleanup timer cancelled (reconnected)`, { component: "cloud", userId, event: "cleanup.cancelled" });
  }

  // New session — create MCP server + transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      sessionOwners.set(sid, userId);
      activeSessionCount.set(userId, (activeSessionCount.get(userId) ?? 0) + 1);
      logger.info(`MCP session started: ${sid}`, { component: "cloud", userId, event: "session.start", sessionId: sid, active: activeSessionCount.get(userId) });
    },
    onsessionclosed: (sid) => {
      transports.delete(sid);
      sessionOwners.delete(sid);

      const remaining = (activeSessionCount.get(userId) ?? 1) - 1;
      activeSessionCount.set(userId, remaining);
      logger.info(`MCP session closed: ${sid}`, { component: "cloud", userId, event: "session.close", sessionId: sid, remaining });

      // Only disconnect Telegram when the LAST MCP session for this user closes
      if (remaining > 0) return;

      activeSessionCount.delete(userId);

      // Immediately disconnect Telegram client to stop GramJS update loop (no more TIMEOUT spam)
      // Session string is already saved in SQLite — reconnect will restore from it
      sessions.disconnectUser(userId);

      // Schedule full cleanup — if user doesn't reconnect within CLEANUP_DELAY_MS, destroy session
      const timer = setTimeout(async () => {
        cleanupTimers.delete(userId);
        logger.info(`Cleanup timer fired, destroying session`, { component: "cloud", userId, event: "cleanup.fired" });
        await sessions.destroyUserSession(userId);
      }, CLEANUP_DELAY_MS);

      cleanupTimers.set(userId, timer);
      logger.info(`Cleanup timer set (${CLEANUP_DELAY_MS / 60000}m)`, { component: "cloud", userId, event: "cleanup.scheduled" });
    },
  });

  const server = new McpServer({
    name: "mcp-telegram-cloud",
    version: "0.1.0",
    icons: [{ src: "https://mcp-telegram.com/icon.svg", mimeType: "image/svg+xml" }],
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
    logger.warn(`Session revoked, cleaning up`, { component: "cloud", userId, event: "session.revoked" });
    await sessions.destroyUserSession(userId);
  };

  const FREE_TIER_LIMIT = 100;

  const onToolCall = (toolName: string) => {
    usage.logToolCall(userId, toolName);
    logger.info(`Tool call: ${toolName}`, { component: "tools", userId, event: "tool.call", tool: toolName });
  };

  const checkRateLimit = (toolName: string): string | null => {
    const todayCount = usage.getTodayCount(userId);
    if (todayCount >= FREE_TIER_LIMIT) {
      logger.warn(`Rate limit hit: ${todayCount}/${FREE_TIER_LIMIT}`, { component: "tools", userId, event: "rate_limit.hit", tool: toolName, count: todayCount });
      return `Daily limit reached (${todayCount}/${FREE_TIER_LIMIT} calls today). Upgrade to Pro for 5,000 calls/day at mcp-telegram.com`;
    }
    return null;
  };

  registerReadOnlyTools(server, getTelegram, requireConnection, onSessionRevoked, onToolCall, checkRateLimit);

  await server.connect(transport);
  return transport.handleRequest(req);
}
