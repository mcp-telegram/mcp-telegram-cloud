import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { z } from "zod";

type RequireConnection = () => Promise<string | null>;
type OnSessionRevoked = () => Promise<void>;
type RateLimitCheck = (toolName: string) => string | null;

const RATE_LIMIT_MSG =
  "Daily tool call limit reached (100 calls/day on free tier). Upgrade to Pro for 5,000 calls/day at mcp-telegram.com";

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

function handleToolError(e: unknown, onRevoked: OnSessionRevoked): { content: { type: "text"; text: string }[] } {
  if (isAuthError(e)) {
    onRevoked().catch(() => {});
    return { content: [{ type: "text", text: SESSION_REVOKED_MSG }] };
  }
  return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
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

  server.tool("telegram-status", "Check Telegram connection status", {}, async () => {
    const limited = trackCall("telegram-status");
    if (limited) return limited;
    const telegram = getTelegram();
    if (await telegram.ensureConnected()) {
      try {
        const me = await telegram.getMe();
        return {
          content: [
            {
              type: "text",
              text: `Connected as ${me.firstName ?? ""} (@${me.username ?? "unknown"}, id: ${me.id})`,
            },
          ],
        };
      } catch (e) {
        return handleToolError(e, onRevoked);
      }
    }
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
    async ({ limit, offsetDate, filterType }) => {
      const limited = trackCall("telegram-list-chats");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const dialogs = await getTelegram().getDialogs(limit, offsetDate, filterType);
        const text = dialogs
          .map(
            (d) =>
              `${d.type === "group" ? "G" : d.type === "channel" ? "C" : "P"} ${d.name} (${d.id}) ${d.unreadCount > 0 ? `[${d.unreadCount} unread]` : ""}`,
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "No chats" }] };
      } catch (e) {
        return handleToolError(e, onRevoked);
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
    async ({ chatId, limit, offsetId, minDate, maxDate }) => {
      const limited = trackCall("telegram-read-messages");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const messages = await getTelegram().getMessages(chatId, limit, offsetId, minDate, maxDate);
        const text = messages
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: text || "No messages" }] };
      } catch (e) {
        return handleToolError(e, onRevoked);
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
    async ({ query, limit }) => {
      const limited = trackCall("telegram-search-chats");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const results = await getTelegram().searchChats(query, limit);
        const text = results
          .map(
            (c) =>
              `${c.type === "group" ? "G" : c.type === "channel" ? "C" : "P"} ${c.name}${c.username ? ` (@${c.username})` : ""} (${c.id})`,
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "No results" }] };
      } catch (e) {
        return handleToolError(e, onRevoked);
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
    async ({ chatId, query, limit, minDate, maxDate }) => {
      const limited = trackCall("telegram-search-messages");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const messages = await getTelegram().searchMessages(chatId, query, limit, minDate, maxDate);
        const text = messages
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: text || "No messages found" }] };
      } catch (e) {
        return handleToolError(e, onRevoked);
      }
    },
  );

  server.tool(
    "telegram-get-unread",
    "Get unread Telegram chats",
    {
      limit: z.number().default(20).describe("Number of unread chats to return"),
    },
    async ({ limit }) => {
      const limited = trackCall("telegram-get-unread");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const dialogs = await getTelegram().getUnreadDialogs(limit);
        const text = dialogs
          .map(
            (d) =>
              `${d.type === "group" ? "G" : d.type === "channel" ? "C" : "P"} ${d.name} (${d.id}) [${d.unreadCount} unread]`,
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "No unread chats" }] };
      } catch (e) {
        return handleToolError(e, onRevoked);
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
    async ({ chatId, limit }) => {
      const limited = trackCall("telegram-get-chat-members");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const members = await getTelegram().getChatMembers(chatId, limit);
        const text = members.map((m) => `${m.name}${m.username ? ` (@${m.username})` : ""} [${m.id}]`).join("\n");
        return { content: [{ type: "text", text: text || "No members found (may require joining the group)" }] };
      } catch (e) {
        return handleToolError(e, onRevoked);
      }
    },
  );

  server.tool(
    "telegram-get-contacts",
    "Get your Telegram contacts list",
    {
      limit: z.number().default(50).describe("Max number of contacts to return"),
    },
    async ({ limit }) => {
      const limited = trackCall("telegram-get-contacts");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const contacts = await getTelegram().getContacts(limit);
        const text = contacts
          .map((c) => `${c.name}${c.username ? ` (@${c.username})` : ""}${c.phone ? ` [+${c.phone}]` : ""} (${c.id})`)
          .join("\n");
        return { content: [{ type: "text", text: text || "No contacts" }] };
      } catch (e) {
        return handleToolError(e, onRevoked);
      }
    },
  );

  server.tool(
    "telegram-get-chat-info",
    "Get detailed info about a Telegram chat",
    {
      chatId: z.string().describe("Chat ID or username"),
    },
    async ({ chatId }) => {
      const limited = trackCall("telegram-get-chat-info");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const info = await getTelegram().getChatInfo(chatId);
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
        return handleToolError(e, onRevoked);
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
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-download-media");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const MAX_SIZE = 950_000; // ~950KB to stay under 1MB base64 limit
        const { buffer, mimeType } = await getTelegram().downloadMediaAsBuffer(chatId, messageId);

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
        return handleToolError(e, onRevoked);
      }
    },
  );
}
