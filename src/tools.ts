import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { z } from "zod";

type RequireConnection = () => Promise<string | null>;

/**
 * Register 7 read-only Telegram tools on the given MCP server.
 * Write operations (send, edit, delete, forward, pin, etc.) are intentionally excluded.
 */
export function registerReadOnlyTools(
  server: McpServer,
  getTelegram: () => TelegramService,
  requireConnection: RequireConnection,
) {
  server.tool("telegram-status", "Check Telegram connection status", {}, async () => {
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
      } catch {
        return { content: [{ type: "text", text: "Connected, but failed to get user info" }] };
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
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
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
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const messages = await getTelegram().getMessages(chatId, limit, offsetId, minDate, maxDate);
        const text = messages
          .map(
            (m) =>
              `[${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: text || "No messages" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
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
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
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
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };

      try {
        const messages = await getTelegram().searchMessages(chatId, query, limit, minDate, maxDate);
        const text = messages
          .map(
            (m) =>
              `[${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: text || "No messages found" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
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
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
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
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
      }
    },
  );
}
