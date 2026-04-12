import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { z } from "zod";
import { logger } from "./logger.js";

type RequireConnection = () => Promise<string | null>;
type OnSessionRevoked = () => Promise<void>;
type RateLimitCheck = (toolName: string) => string | null;

/** Remove unpaired UTF-16 surrogates that break JSON serialization */
function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** Most cloud tools are read-only — annotate accordingly for ChatGPT/Claude */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Mark-as-read is a safe state-change operation (not destructive, not read-only) */
const MARK_READ_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Format reactions array into compact text like: [👍×5 ❤️×3(me) 🔥×1] */
function formatReactions(reactions?: { emoji: string; count: number; me: boolean }[]): string {
  if (!reactions?.length) return "";
  const parts = reactions.map((r) => `${r.emoji}×${r.count}${r.me ? "(me)" : ""}`);
  return ` [${parts.join(" ")}]`;
}

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
  "Telegram session was revoked or expired. Please reconnect: Disconnect → Connect again in your app settings.";

function handleToolError(
  e: unknown,
  onRevoked: OnSessionRevoked,
  toolName?: string,
): { content: { type: "text"; text: string }[]; isError: true } {
  const msg = (e as Error).message ?? String(e);
  if (isAuthError(e)) {
    logger.warn(`Auth error in ${toolName ?? "unknown"}: ${msg}`, {
      component: "tools",
      event: "tool.auth_error",
      tool: toolName ?? "",
    });
    onRevoked().catch(() => {});
    return { content: [{ type: "text", text: SESSION_REVOKED_MSG }], isError: true as const };
  }
  logger.error(`Tool error in ${toolName ?? "unknown"}: ${msg}`, {
    component: "tools",
    event: "tool.error",
    tool: toolName ?? "",
    error: msg,
  });
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true as const };
}

/**
 * Register read-only Telegram tools + safe state-change tools on the given MCP server.
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

  server.registerTool(
    "telegram-status",
    { description: "Check Telegram connection status", annotations: READ_ONLY_ANNOTATIONS },
    async () => {
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
    },
  );

  server.registerTool(
    "telegram-list-chats",
    {
      description: "List Telegram chats",
      inputSchema: {
        limit: z.number().default(20).describe("Number of chats to return"),
        offsetDate: z.number().optional().describe("Unix timestamp offset for pagination"),
        filterType: z
          .enum(["private", "group", "channel", "contact_requests"])
          .optional()
          .describe("Filter by chat type. 'contact_requests' shows only private chats from non-contacts"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
          .map((d) => {
            const prefix = d.type === "group" ? "G" : d.type === "channel" ? "C" : "P";
            const botTag = d.isBot ? " [bot]" : "";
            const contactTag = d.type === "private" && d.isContact === false ? " [not in contacts]" : "";
            const unread = d.unreadCount > 0 ? ` [${d.unreadCount} unread]` : "";
            return `${prefix} ${d.name} (${d.id})${botTag}${contactTag}${unread}`;
          })
          .join("\n");
        return { content: [{ type: "text", text: sanitize(text) || "No chats" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-list-chats");
      }
    },
  );

  server.registerTool(
    "telegram-read-messages",
    {
      description: "Read recent messages from a Telegram chat",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        limit: z.number().default(10).describe("Number of messages to return"),
        offsetId: z.number().optional().describe("Message ID to start from (for pagination)"),
        minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
        maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}${formatReactions(m.reactions)}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: sanitize(text) || "No messages" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-read-messages");
      }
    },
  );

  server.registerTool(
    "telegram-search-chats",
    {
      description: "Search for Telegram chats/users/channels by name or username",
      inputSchema: {
        query: z.string().describe("Search query (name or username)"),
        limit: z.number().default(10).describe("Max results"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
              `${c.type === "group" ? "G" : c.type === "channel" ? "C" : "P"} ${c.name}${c.username ? ` (@${c.username})` : ""} (${c.id})${c.membersCount ? ` [${c.membersCount} members]` : ""}${c.description ? ` — ${c.description.split("\n")[0].slice(0, 100)}` : ""}`,
          )
          .join("\n");
        return { content: [{ type: "text", text: sanitize(text) || "No results" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-search-chats");
      }
    },
  );

  server.registerTool(
    "telegram-search-global",
    {
      description: "Search messages globally across all public Telegram chats and channels",
      inputSchema: {
        query: z.string().describe("Search text"),
        limit: z.number().default(20).describe("Max results"),
        minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
        maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, limit, minDate, maxDate }) => {
      const limited = trackCall("telegram-search-global");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const messages = await getTelegram().searchGlobal(query, limit, minDate, maxDate);
        logDuration("telegram-search-global", start);
        const text = messages
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] [${m.chat.type === "channel" ? "C" : m.chat.type === "group" ? "G" : "P"} ${m.chat.name}${m.chat.username ? ` @${m.chat.username}` : ""}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}${formatReactions(m.reactions)}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: sanitize(text) || "No messages found" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-search-global");
      }
    },
  );

  server.registerTool(
    "telegram-search-messages",
    {
      description: "Search messages in a Telegram chat by text",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        query: z.string().describe("Search text"),
        limit: z.number().default(20).describe("Max results"),
        minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
        maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}${formatReactions(m.reactions)}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: sanitize(text) || "No messages found" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-search-messages");
      }
    },
  );

  server.registerTool(
    "telegram-get-unread",
    {
      description: "Get unread Telegram chats",
      inputSchema: {
        limit: z.number().default(20).describe("Number of unread chats to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
          .map((d) => {
            const prefix = d.type === "group" ? "G" : d.type === "channel" ? "C" : "P";
            const botTag = d.isBot ? " [bot]" : "";
            const contactTag = d.type === "private" && d.isContact === false ? " [not in contacts]" : "";
            const forumTag = d.forum ? " [forum]" : "";
            let line = `${prefix} ${d.name} (${d.id})${botTag}${contactTag}${forumTag} [${d.unreadCount} unread]`;
            if (d.topics) {
              for (const t of d.topics) {
                line += `\n  # ${t.title} [${t.unreadCount} unread]`;
              }
            }
            return line;
          })
          .join("\n");
        return { content: [{ type: "text", text: sanitize(text) || "No unread chats" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-unread");
      }
    },
  );

  server.registerTool(
    "telegram-get-chat-members",
    {
      description: "Get members/participants of a Telegram group or channel",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        limit: z.number().default(50).describe("Max number of members to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
        return {
          content: [{ type: "text", text: sanitize(text) || "No members found (may require joining the group)" }],
        };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-chat-members");
      }
    },
  );

  server.registerTool(
    "telegram-get-contacts",
    {
      description: "Get your Telegram contacts list",
      inputSchema: {
        limit: z.number().default(50).describe("Max number of contacts to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
        return { content: [{ type: "text", text: sanitize(text) || "No contacts" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-contacts");
      }
    },
  );

  server.registerTool(
    "telegram-get-chat-info",
    {
      description: "Get detailed info about a Telegram chat",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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
          ...(info.forum ? ["Forum: yes"] : []),
          ...(info.isBot != null ? [`Bot: ${info.isBot ? "yes" : "no"}`] : []),
          ...(info.isContact != null ? [`In contacts: ${info.isContact ? "yes" : "no"}`] : []),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-chat-info");
      }
    },
  );

  server.registerTool(
    "telegram-get-contact-requests",
    {
      description:
        "Get incoming messages from non-contacts (contact requests). Shows who messaged you without being in your contacts, with message preview",
      inputSchema: {
        limit: z.number().default(20).describe("Number of contact requests to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      const limited = trackCall("telegram-get-contact-requests");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const requests = await getTelegram().getContactRequests(limit);
        logDuration("telegram-get-contact-requests", start);
        if (requests.length === 0) {
          return { content: [{ type: "text", text: "No contact requests" }] };
        }
        const text = requests
          .map((r) => {
            const tag = r.isBot ? "[bot]" : "[user]";
            const username = r.username ? ` @${r.username}` : "";
            const unread = r.unreadCount > 0 ? ` [${r.unreadCount} unread]` : "";
            const preview = r.lastMessage ? `\n  > ${r.lastMessage.slice(0, 100)}` : "";
            return `${tag} ${r.name}${username} (${r.id})${unread}${preview}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-contact-requests");
      }
    },
  );

  server.registerTool(
    "telegram-download-media",
    {
      description: "Download media (photo, video, document) from a Telegram message and return it inline",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        messageId: z.number().describe("Message ID containing media"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
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

  server.registerTool(
    "telegram-list-topics",
    {
      description:
        "List forum topics in a Telegram group with Topics enabled. Shows topic names, unread counts, and status",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username of a group with Topics enabled"),
        limit: z.number().default(100).describe("Max topics to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, limit }) => {
      const limited = trackCall("telegram-list-topics");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const topics = await getTelegram().getForumTopics(chatId, limit);
        logDuration("telegram-list-topics", start);
        const text = topics
          .map((t) => {
            const flags = [
              t.pinned ? "pinned" : "",
              t.closed ? "closed" : "",
              t.unreadCount > 0 ? `${t.unreadCount} unread` : "",
            ]
              .filter(Boolean)
              .join(", ");
            return `# ${t.title} (id: ${t.id})${flags ? ` [${flags}]` : ""}`;
          })
          .join("\n");
        return { content: [{ type: "text", text: sanitize(text) || "No topics found" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-list-topics");
      }
    },
  );

  server.registerTool(
    "telegram-read-topic-messages",
    {
      description: "Read messages from a specific forum topic in a Telegram group",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        topicId: z.number().describe("Topic ID (get from telegram-list-topics)"),
        limit: z.number().default(20).describe("Number of messages to return"),
        offsetId: z.number().optional().describe("Message ID to start from (for pagination)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, topicId, limit, offsetId }) => {
      const limited = trackCall("telegram-read-topic-messages");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const messages = await getTelegram().getTopicMessages(chatId, topicId, limit, offsetId);
        logDuration("telegram-read-topic-messages", start);
        const text = messages
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}${formatReactions(m.reactions)}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: sanitize(text) || "No messages in topic" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-read-topic-messages");
      }
    },
  );

  server.registerTool(
    "telegram-get-reactions",
    {
      description: "Get detailed reaction info for a message: which reactions, counts, and who reacted (when visible)",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        messageId: z.number().describe("Message ID to get reactions for"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-get-reactions");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const result = await getTelegram().getMessageReactions(chatId, messageId);
        logDuration("telegram-get-reactions", start);
        if (result.reactions.length === 0) {
          return { content: [{ type: "text", text: `No reactions on message ${messageId}` }] };
        }
        const lines = result.reactions.map((r) => {
          const usersStr = r.users.length > 0 ? `: ${r.users.map((u) => u.name).join(", ")}` : "";
          return `${r.emoji} × ${r.count}${usersStr}`;
        });
        lines.push(`\nTotal: ${result.total} reactions`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-reactions");
      }
    },
  );

  server.registerTool(
    "telegram-get-profile",
    {
      description: "Get detailed profile info of a Telegram user including bio, birthday, business info and more",
      inputSchema: {
        userId: z.string().describe("User ID or username"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ userId }) => {
      const limited = trackCall("telegram-get-profile");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const profile = await getTelegram().getProfile(userId);
        logDuration("telegram-get-profile", start);
        const lines = [
          `Name: ${profile.name}`,
          `ID: ${profile.id}`,
          ...(profile.username ? [`Username: @${profile.username}`] : []),
          ...(profile.bio ? [`Bio: ${profile.bio}`] : []),
          `Photo: ${profile.photo ? "yes" : "no"}`,
          ...(profile.premium ? ["Premium: yes"] : []),
          ...(profile.lastSeen ? [`Last seen: ${profile.lastSeen}`] : []),
          ...(profile.birthday ? [`Birthday: ${profile.birthday}`] : []),
          ...(profile.commonChatsCount ? [`Common chats: ${profile.commonChatsCount}`] : []),
          ...(profile.personalChannelId ? [`Personal channel ID: ${profile.personalChannelId}`] : []),
          ...(profile.businessLocation ? [`Business location: ${profile.businessLocation}`] : []),
          ...(profile.businessWorkHours ? [`Business hours timezone: ${profile.businessWorkHours}`] : []),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-profile");
      }
    },
  );

  server.registerTool(
    "telegram-get-profile-photo",
    {
      description: "Download profile photo of a Telegram user, group, or channel and return it inline",
      inputSchema: {
        entityId: z.string().describe("User/Chat/Channel ID or username"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ entityId }) => {
      const limited = trackCall("telegram-get-profile-photo");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const MAX_SIZE = 950_000;
        const result = await getTelegram().downloadProfilePhoto(entityId);
        logDuration("telegram-get-profile-photo", start);

        if (!result || !("buffer" in result)) {
          return { content: [{ type: "text", text: "No profile photo found" }] };
        }

        if (result.buffer.length > MAX_SIZE) {
          return {
            content: [
              {
                type: "text",
                text: `Profile photo too large for inline display (${(result.buffer.length / 1024).toFixed(0)} KB, limit ~950 KB).`,
              },
            ],
          };
        }

        return {
          content: [
            { type: "image", data: result.buffer.toString("base64"), mimeType: result.mimeType },
            {
              type: "text",
              text: `Profile photo (${(result.buffer.length / 1024).toFixed(0)} KB, ${result.mimeType})`,
            },
          ],
        };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-profile-photo");
      }
    },
  );

  server.registerTool(
    "telegram-mark-as-read",
    {
      description: "Mark a Telegram chat as read. Marks all messages in the specified chat as read/seen",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
      },
      annotations: MARK_READ_ANNOTATIONS,
    },
    async ({ chatId }) => {
      const limited = trackCall("telegram-mark-as-read");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        await getTelegram().markAsRead(chatId);
        logDuration("telegram-mark-as-read", start);
        return { content: [{ type: "text", text: `Marked ${chatId} as read` }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-mark-as-read");
      }
    },
  );

  // ── v1.23.0 account tools ────────────────────────────────────────────────

  server.registerTool(
    "telegram-mute-chat",
    {
      description:
        "Mute or unmute notifications for a Telegram chat. Set muted=true to mute (optionally with duration in seconds), muted=false to unmute",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        muted: z.boolean().describe("true to mute, false to unmute"),
        duration: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Mute duration in seconds (only when muted=true). Omit to mute forever"),
      },
      annotations: MARK_READ_ANNOTATIONS,
    },
    async ({ chatId, muted, duration }) => {
      const limited = trackCall("telegram-mute-chat");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const MUTE_FOREVER = 2147483647;
        let muteUntil: number;
        if (!muted) {
          muteUntil = 0;
        } else if (duration !== undefined && duration > 0) {
          muteUntil = Math.min(Math.floor(Date.now() / 1000) + duration, MUTE_FOREVER);
        } else {
          muteUntil = MUTE_FOREVER;
        }
        await getTelegram().muteChat(chatId, muteUntil);
        logDuration("telegram-mute-chat", start);
        const status = !muted
          ? "unmuted"
          : duration !== undefined && duration > 0
            ? `muted for ${duration}s`
            : "muted forever";
        return { content: [{ type: "text", text: `Chat ${chatId} ${status}` }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-mute-chat");
      }
    },
  );

  server.registerTool(
    "telegram-get-chat-folders",
    {
      description: "Get list of your Telegram chat folders (filters) with their names and chat counts",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-chat-folders");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const folders = await getTelegram().getChatFolders();
        logDuration("telegram-get-chat-folders", start);
        if (folders.length === 0) return { content: [{ type: "text", text: "No chat folders" }] };
        const text = folders
          .map(
            (f) =>
              `[${f.id}] ${f.emoticon ? `${f.emoticon} ` : ""}${f.title} (${f.includeCount} chats, ${f.pinnedCount} pinned)`,
          )
          .join("\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-chat-folders");
      }
    },
  );

  server.registerTool(
    "telegram-get-sessions",
    {
      description:
        "Get list of all active Telegram sessions (logged-in devices) with device info, IP, and last active time",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-sessions");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const sessions = await getTelegram().getActiveSessions();
        logDuration("telegram-get-sessions", start);
        if (sessions.length === 0) return { content: [{ type: "text", text: "No active sessions" }] };
        const text = sessions
          .map(
            (s) =>
              `${s.current ? "→ " : "  "}${s.device} (${s.platform}) — ${s.appName} ${s.appVersion}\n    IP: ${s.ip} (${s.country}) | Last active: ${s.dateActive}${s.current ? " [CURRENT]" : ""}\n    Hash: ${s.hash}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-sessions");
      }
    },
  );

  server.registerTool(
    "telegram-get-invite-links",
    {
      description:
        "Get list of invite links for a group or channel. By default returns links created by the current account",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        limit: z.number().default(20).describe("Max links to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, limit }) => {
      const limited = trackCall("telegram-get-invite-links");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const links = await getTelegram().getInviteLinks(chatId, limit);
        logDuration("telegram-get-invite-links", start);
        if (links.length === 0) return { content: [{ type: "text", text: "No invite links" }] };
        const text = links
          .map(
            (l) =>
              `${l.link}${l.title ? ` (${l.title})` : ""} — ${l.usageCount} uses${l.expired ? " [EXPIRED]" : ""}${l.revoked ? " [REVOKED]" : ""}`,
          )
          .join("\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-invite-links");
      }
    },
  );

  // ── v1.24.0 sticker tools ────────────────────────────────────────────────

  server.registerTool(
    "telegram-get-sticker-set",
    {
      description:
        "Get all stickers from a sticker set by its short name. Returns each sticker with index and emoji. Use the index with telegram-send-sticker to send a specific sticker",
      inputSchema: {
        shortName: z
          .string()
          .describe(
            "Short name of the sticker set (e.g. 'AnimatedEmojis', 'HotCherry'). Find names via telegram-search-sticker-sets or from t.me/addstickers/<shortName> links",
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ shortName }) => {
      const limited = trackCall("telegram-get-sticker-set");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const set = await getTelegram().getStickerSet(shortName);
        logDuration("telegram-get-sticker-set", start);
        const lines: string[] = [];
        lines.push(`📦 ${set.title} (${set.shortName})`);
        lines.push(`${set.count} stickers`);
        lines.push("");
        for (let i = 0; i < set.stickers.length; i++) {
          lines.push(`[${i}] ${set.stickers[i].emoji}`);
        }
        lines.push("");
        lines.push(`Send a sticker: telegram-send-sticker(chatId, stickerSet="${set.shortName}", index=N)`);
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-sticker-set");
      }
    },
  );

  server.registerTool(
    "telegram-search-sticker-sets",
    {
      description:
        "Search for sticker sets by name or keyword. Returns matching sticker pack names that can be used with telegram-get-sticker-set",
      inputSchema: {
        query: z.string().describe("Search query (e.g. 'cat', 'love', 'pepe', 'anime')"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query }) => {
      const limited = trackCall("telegram-search-sticker-sets");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const sets = await getTelegram().searchStickerSets(query);
        logDuration("telegram-search-sticker-sets", start);
        if (sets.length === 0)
          return { content: [{ type: "text", text: `No sticker sets found for "${query}". Try different keywords.` }] };
        const lines: string[] = [`Found ${sets.length} sticker set(s) for "${query}":\n`];
        for (const set of sets) {
          lines.push(`• ${set.title} — ${set.count} stickers`);
          lines.push(`  Short name: ${set.shortName}`);
        }
        lines.push("");
        lines.push("Use telegram-get-sticker-set(shortName) to see individual stickers.");
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-search-sticker-sets");
      }
    },
  );

  server.registerTool(
    "telegram-get-installed-stickers",
    {
      description:
        "List all sticker sets installed by the user. Returns pack names and short names for use with other sticker tools",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-installed-stickers");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const sets = await getTelegram().getInstalledStickerSets();
        logDuration("telegram-get-installed-stickers", start);
        if (sets.length === 0) return { content: [{ type: "text", text: "No sticker sets installed." }] };
        const lines: string[] = [`${sets.length} installed sticker set(s):\n`];
        for (const set of sets) {
          lines.push(`• ${set.title} — ${set.count} stickers`);
          lines.push(`  Short name: ${set.shortName}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-installed-stickers");
      }
    },
  );

  server.registerTool(
    "telegram-get-recent-stickers",
    {
      description: "Get recently used stickers. Returns each sticker with its list index and associated emoji",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-recent-stickers");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const stickers = await getTelegram().getRecentStickers();
        logDuration("telegram-get-recent-stickers", start);
        if (stickers.length === 0) return { content: [{ type: "text", text: "No recent stickers." }] };
        const lines: string[] = [`${stickers.length} recent sticker(s):\n`];
        for (let i = 0; i < stickers.length; i++) {
          lines.push(`[${i}] ${stickers[i].emoji}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-recent-stickers");
      }
    },
  );
}
