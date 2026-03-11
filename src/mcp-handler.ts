import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SessionManager } from "./session-manager.js";
import { registerReadOnlyTools } from "./tools.js";

/** Map of MCP session ID → transport (for multi-request sessions) */
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

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

  // New session — create MCP server + transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      console.log(`[cloud] MCP session started: ${sid} for user ${userId}`);
    },
    onsessionclosed: (sid) => {
      transports.delete(sid);
      console.log(`[cloud] MCP session closed: ${sid}`);
    },
  });

  const server = new McpServer({
    name: "mcp-telegram-cloud",
    version: "0.1.0",
  });

  const telegram = await sessions.getOrCreateSession(userId);

  const requireConnection = async (): Promise<string | null> => {
    if (await telegram.ensureConnected()) return null;
    const reason = telegram.lastError ? ` ${telegram.lastError}` : "";
    return `Not connected to Telegram.${reason}`;
  };

  registerReadOnlyTools(server, () => telegram, requireConnection);

  await server.connect(transport);
  return transport.handleRequest(req);
}
