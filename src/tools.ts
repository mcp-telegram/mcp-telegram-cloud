import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { z } from "zod";
import { logger } from "./logger.js";

type RequireConnection = () => Promise<string | null>;
type OnSessionRevoked = () => Promise<void>;
type RateLimitCheck = (toolName: string) => string | null;

/** All cloud tools are read-only — annotate accordingly for ChatGPT/Claude */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const AUTH_ERROR_PATTERNS = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
];

function isAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return AUTH_ERROR_PATTERNS.some((p) => msg.includes(p));
}

const SESSION_REVOKED_MSG =
  "Telegram session was revoked or expired. Please reconnect the connector in Claude.ai (Disconnect → Connect again).";

function handleToolError(
  e: unknown,
  onRevoked: OnSessionRevoked,
  toolName?: string,
): { content: { type: "text"; text: string }[] } {
  const msg = (e as Error).message ?? String(e);
  if (isAuthError(e)) {
    logger.warn(`Auth error in ${toolName ?? "unknown"}: ${msg}`, {
      component: "tools",
      event: "tool.auth_error",
      tool: toolName ?? "",
    });
    onRevoked().catch(() => {});
    return { content: [{ type: "text", text: SESSION_REVOKED_MSG }] };
  }
  logger.error(`Tool error in ${toolName ?? "unknown"}: ${msg}`, {
    component: "tools",
    event: "tool.error",
    tool: toolName ?? "",
    error: msg,
  });
  return { content: [{ type: "text", text: `Error: ${msg}` }] };
}

/**
 * Register 10 read-only Telegram tools on the given MCP server.
 * Write operations (send, edit, delete, forward, pin, etc.) are intentionally excluded.
 */
export function registerReadOnlyTools(
  server: McpServer,
  getTelegram: () => TelegramService,
  requireConnection: RequireConnection,
  onSessionRevoked?: OnSessionRevoked,
  onToolCall?: (toolName: string) => void,
  checkRateLimit?: RateLimitCheck,
) {
  const onRevoked = onSessionRevoked ?? (async () => {});

  /** Log tool call and check rate limit. Returns error response if limit exceeded, null otherwise. */
  const trackCall = (toolName: string) => {
    onToolCall?.(toolName);
    const limitErr = checkRateLimit?.(toolName);
    if (limitErr) return { content: [{ type: "text" as const, text: limitErr }] };
    return null;
  };

  /** Log tool call duration after execution */
  const logDuration = (toolName: string, startMs: number) => {
    const duration = Date.now() - startMs;
    logger.info(`Tool ${toolName} completed in ${duration}ms`, {
      component: "tools",
      event: "tool.duration",
      tool: toolName,
      durationMs: duration,
    });
  };

  server.tool("telegram-status", "Check Telegram connection status", {}, READ_ONLY_ANNOTATIONS, async () => {
    const limited = trackCall("telegram-status");
    if (limited) return limited;
    const start = Date.now();
    const telegram = getTelegram();
    if (await telegram.ensureConnected()) {
      try {
        const me = await telegram.getMe();
        logDuration("telegram-status", start);
        return {
          content: [
            {
              type: "text",
              text: `Connected as ${me.firstName ?? ""} (@${me.username ?? "unknown"}, id: ${me.id})`,
            },
          ],
        };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-status");
      }
    }
    logDuration("telegram-status", start);
    const reason = telegram.lastError ? ` Reason: ${telegram.lastError}` : "";
    return {
      content: [{ type: "text", text: `Not connected.${reason}` }],
    };
  });

  server.tool(
    "telegram-list-chats",
    "List Telegram chats",
    {
      limit: z.number().default(20).describe("Number of chats to return"),
      offsetDate: z.number().optional().describe("Unix timestamp offset for pagination"),
      filterType: z.enum(["private", "group", "channel"]).optional().describe("Filter by chat type"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, offsetDate, filterType }) => {
      const limited = trackCall("telegram-list-chats");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const dialogs = await getTelegram().getDialogs(limit, offsetDate, filterType);
        logDuration("telegram-list-chats", start);
        const text = dialogs
          .map(
            (d) =>
              `${d.type === "group" ? "G" : d.type === "channel" ? "C" : "P"} ${d.name} (${d.id}) ${d.unreadCount > 0 ? `[${d.unreadCount} unread]` : ""}`,
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "No chats" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-list-chats");
      }
    },
  );

  server.tool(
    "telegram-read-messages",
    "Read recent messages from a Telegram chat",
    {
      chatId: z.string().describe("Chat ID or username"),
      limit: z.number().default(10).describe("Number of messages to return"),
      offsetId: z.number().optional().describe("Message ID to start from (for pagination)"),
      minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
      maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ chatId, limit, offsetId, minDate, maxDate }) => {
      const limited = trackCall("telegram-read-messages");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const messages = await getTelegram().getMessages(chatId, limit, offsetId, minDate, maxDate);
        logDuration("telegram-read-messages", start);
        const text = messages
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: text || "No messages" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-read-messages");
      }
    },
  );

  server.tool(
    "telegram-search-chats",
    "Search for Telegram chats/users/channels by name or username",
    {
      query: z.string().describe("Search query (name or username)"),
      limit: z.number().default(10).describe("Max results"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ query, limit }) => {
      const limited = trackCall("telegram-search-chats");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const results = await getTelegram().searchChats(query, limit);
        logDuration("telegram-search-chats", start);
        const text = results
          .map(
            (c) =>
              `${c.type === "group" ? "G" : c.type === "channel" ? "C" : "P"} ${c.name}${c.username ? ` (@${c.username})` : ""} (${c.id})`,
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "No results" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-search-chats");
      }
    },
  );

  server.tool(
    "telegram-search-messages",
    "Search messages in a Telegram chat by text",
    {
      chatId: z.string().describe("Chat ID or username"),
      query: z.string().describe("Search text"),
      limit: z.number().default(20).describe("Max results"),
      minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
      maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ chatId, query, limit, minDate, maxDate }) => {
      const limited = trackCall("telegram-search-messages");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const messages = await getTelegram().searchMessages(chatId, query, limit, minDate, maxDate);
        logDuration("telegram-search-messages", start);
        const text = messages
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: text || "No messages found" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-search-messages");
      }
    },
  );

  server.tool(
    "telegram-get-unread",
    "Get unread Telegram chats",
    {
      limit: z.number().default(20).describe("Number of unread chats to return"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit }) => {
      const limited = trackCall("telegram-get-unread");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const dialogs = await getTelegram().getUnreadDialogs(limit);
        logDuration("telegram-get-unread", start);
        const text = dialogs
          .map(
            (d) =>
              `${d.type === "group" ? "G" : d.type === "channel" ? "C" : "P"} ${d.name} (${d.id}) [${d.unreadCount} unread]`,
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "No unread chats" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-unread");
      }
    },
  );

  server.tool(
    "telegram-get-chat-members",
    "Get members/participants of a Telegram group or channel",
    {
      chatId: z.string().describe("Chat ID or username"),
      limit: z.number().default(50).describe("Max number of members to return"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ chatId, limit }) => {
      const limited = trackCall("telegram-get-chat-members");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const members = await getTelegram().getChatMembers(chatId, limit);
        logDuration("telegram-get-chat-members", start);
        const text = members.map((m) => `${m.name}${m.username ? ` (@${m.username})` : ""} [${m.id}]`).join("\n");
        return { content: [{ type: "text", text: text || "No members found (may require joining the group)" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-chat-members");
      }
    },
  );

  server.tool(
    "telegram-get-contacts",
    "Get your Telegram contacts list",
    {
      limit: z.number().default(50).describe("Max number of contacts to return"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit }) => {
      const limited = trackCall("telegram-get-contacts");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const contacts = await getTelegram().getContacts(limit);
        logDuration("telegram-get-contacts", start);
        const text = contacts
          .map((c) => `${c.name}${c.username ? ` (@${c.username})` : ""}${c.phone ? ` [+${c.phone}]` : ""} (${c.id})`)
          .join("\n");
        return { content: [{ type: "text", text: text || "No contacts" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-contacts");
      }
    },
  );

  server.tool(
    "telegram-get-chat-info",
    "Get detailed info about a Telegram chat",
    {
      chatId: z.string().describe("Chat ID or username"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ chatId }) => {
      const limited = trackCall("telegram-get-chat-info");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const info = await getTelegram().getChatInfo(chatId);
        logDuration("telegram-get-chat-info", start);
        const lines = [
          `Name: ${info.name}`,
          `ID: ${info.id}`,
          `Type: ${info.type}`,
          ...(info.username ? [`Username: @${info.username}`] : []),
          ...(info.description ? [`Description: ${info.description}`] : []),
          ...(info.membersCount != null ? [`Members: ${info.membersCount}`] : []),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-chat-info");
      }
    },
  );

  server.tool(
    "telegram-download-media",
    "Download media (photo, video, document) from a Telegram message and return it inline",
    {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().describe("Message ID containing media"),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-download-media");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const MAX_SIZE = 950_000; // ~950KB to stay under 1MB base64 limit
        const { buffer, mimeType } = await getTelegram().downloadMediaAsBuffer(chatId, messageId);
        logDuration("telegram-download-media", start);

        if (mimeType.startsWith("image/")) {
          // If image is too large, inform the user about size
          if (buffer.length > MAX_SIZE) {
            return {
              content: [
                {
                  type: "text",
                  text: `Image too large for inline display (${(buffer.length / 1024).toFixed(0)} KB, limit ~950 KB). The image is a ${mimeType} file. Try asking for a specific smaller photo or use telegram-read-messages to see the text content.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "image",
                data: buffer.toString("base64"),
                mimeType,
              },
            ],
          };
        }

        // Non-image: return metadata
        return {
          content: [
            {
              type: "text",
              text: `Media downloaded: ${mimeType}, ${(buffer.length / 1024).toFixed(0)} KB. Non-image media cannot be displayed inline.`,
            },
          ],
        };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-download-media");
      }
    },
  );
}
