import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SessionManager } from "./session-manager.js";
import { registerReadOnlyTools } from "./tools.js";

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
export async function handleMcpRequest(sessions: SessionManager, userId: string, req: Request): Promise<Response> {
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
    console.log(`[cloud] Cleanup timer cancelled for ${userId} (reconnected)`);
  }

  // New session — create MCP server + transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      sessionOwners.set(sid, userId);
      activeSessionCount.set(userId, (activeSessionCount.get(userId) ?? 0) + 1);
      console.log(`[cloud] MCP session started: ${sid} for user ${userId} (active: ${activeSessionCount.get(userId)})`);
    },
    onsessionclosed: (sid) => {
      transports.delete(sid);
      sessionOwners.delete(sid);

      const remaining = (activeSessionCount.get(userId) ?? 1) - 1;
      activeSessionCount.set(userId, remaining);
      console.log(`[cloud] MCP session closed: ${sid} (remaining: ${remaining})`);

      // Only disconnect Telegram when the LAST MCP session for this user closes
      if (remaining > 0) return;

      activeSessionCount.delete(userId);

      // Immediately disconnect Telegram client to stop GramJS update loop (no more TIMEOUT spam)
      // Session string is already saved in SQLite — reconnect will restore from it
      sessions.disconnectUser(userId);

      // Schedule full cleanup — if user doesn't reconnect within CLEANUP_DELAY_MS, destroy session
      const timer = setTimeout(async () => {
        cleanupTimers.delete(userId);
        console.log(
          `[cloud] Cleanup timer fired for ${userId} (no reconnect in ${CLEANUP_DELAY_MS / 60000}m), destroying session...`,
        );
        await sessions.destroyUserSession(userId);
      }, CLEANUP_DELAY_MS);

      cleanupTimers.set(userId, timer);
      console.log(`[cloud] Cleanup timer set for ${userId} (${CLEANUP_DELAY_MS / 60000}m)`);
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
    console.log(`[cloud] Session revoked detected for user ${userId}, cleaning up...`);
    await sessions.destroyUserSession(userId);
  };

  registerReadOnlyTools(server, getTelegram, requireConnection, onSessionRevoked);

  await server.connect(transport);
  return transport.handleRequest(req);
}
