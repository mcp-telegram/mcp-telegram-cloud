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

  // ── v2.2.0 parity wave 1 — 15 read-only tools ────────────────────────────

  server.registerTool(
    "telegram-get-message-link",
    {
      description:
        "Get a t.me link to a specific message in a Telegram channel or supergroup. Private chats and basic groups don't expose shareable message links.",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username (channel or supergroup)"),
        messageId: z.number().int().positive().describe("ID of the message to link to"),
        thread: z.boolean().default(false).describe("Link to the message thread instead of the message itself"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId, thread }) => {
      const limited = trackCall("telegram-get-message-link");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const link = await getTelegram().getMessageLink(chatId, messageId, thread);
        logDuration("telegram-get-message-link", start);
        return { content: [{ type: "text", text: sanitize(link) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-message-link");
      }
    },
  );

  server.registerTool(
    "telegram-get-replies",
    {
      description: "Read reply thread / comments under a Telegram message (channel comments, group thread replies).",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        messageId: z.number().describe("Top-level message ID whose replies you want"),
        limit: z.number().default(20).describe("Max replies to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId, limit }) => {
      const limited = trackCall("telegram-get-replies");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const replies = await getTelegram().getReplies(chatId, messageId, limit);
        logDuration("telegram-get-replies", start);
        const text = replies
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}${formatReactions(m.reactions)}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: sanitize(text) || "No replies" }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-replies");
      }
    },
  );

  server.registerTool(
    "telegram-get-discussion-message",
    {
      description:
        "For a channel post with comments enabled, returns the linked discussion-group info (discussionGroupId, discussionMsgId, unreadCount, topMessage). Use telegram-get-replies on (discussionGroupId, discussionMsgId) to read the comment thread.",
      inputSchema: {
        chatId: z.string().describe("Channel ID or @username that contains the post"),
        messageId: z.number().int().positive().describe("ID of the channel post to get discussion info for"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-get-discussion-message");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const d = await getTelegram().getDiscussionMessage(chatId, messageId);
        logDuration("telegram-get-discussion-message", start);
        const lines: string[] = [
          `Discussion group: ${d.discussionGroupId}`,
          `Discussion message id: ${d.discussionMsgId}`,
          `Unread comments: ${d.unreadCount}`,
        ];
        if (d.topMessage) {
          lines.push(`Top message [#${d.topMessage.id}] (${d.topMessage.date}): ${d.topMessage.text ?? ""}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-discussion-message");
      }
    },
  );

  server.registerTool(
    "telegram-get-saved-dialogs",
    {
      description:
        "List Saved Messages sub-dialogs — Telegram's per-sender grouping of messages forwarded to your Saved Messages.",
      inputSchema: {
        limit: z.number().int().positive().default(20).describe("Max saved dialogs to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      const limited = trackCall("telegram-get-saved-dialogs");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const dialogs = await getTelegram().getSavedDialogs(limit);
        logDuration("telegram-get-saved-dialogs", start);
        if (dialogs.length === 0) return { content: [{ type: "text", text: "No saved dialogs." }] };
        const text = dialogs.map((d) => `${d.peerTitle} (${d.peerId}) — last msg #${d.lastMsgId}`).join("\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-saved-dialogs");
      }
    },
  );

  server.registerTool(
    "telegram-get-scheduled",
    {
      description: "List scheduled (not yet sent) messages in a chat.",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId }) => {
      const limited = trackCall("telegram-get-scheduled");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const messages = await getTelegram().getScheduledMessages(chatId);
        logDuration("telegram-get-scheduled", start);
        if (messages.length === 0) return { content: [{ type: "text", text: "No scheduled messages." }] };
        const text = messages
          .map(
            (m) =>
              `[#${m.id}] [${m.date}] ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-scheduled");
      }
    },
  );

  server.registerTool(
    "telegram-get-drafts",
    {
      description: "List all draft messages across chats (unsent text the user typed and left).",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-drafts");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const drafts = await getTelegram().getAllDrafts();
        logDuration("telegram-get-drafts", start);
        if (drafts.length === 0) return { content: [{ type: "text", text: "No drafts." }] };
        const text = drafts.map((d) => `${d.chatTitle} (${d.chatId}) [${d.date}]: ${d.text}`).join("\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-drafts");
      }
    },
  );

  server.registerTool(
    "telegram-get-poll-results",
    {
      description: "Get current results of a poll message (counts, percentages, your chosen options).",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        messageId: z.number().int().positive().describe("Message ID of the poll"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-get-poll-results");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const p = await getTelegram().getPollResults(chatId, messageId);
        logDuration("telegram-get-poll-results", start);
        const header = `${p.question}${p.isQuiz ? " [quiz]" : ""}${p.isMulti ? " [multi]" : ""}${p.isClosed ? " [closed]" : ""} — ${p.totalVoters} voters`;
        const opts = p.options
          .map((o) => {
            const tags = [o.chosen ? "✓" : "", o.correct ? "★" : ""].filter(Boolean).join("");
            return `  [${o.index}] ${o.text} — ${o.votes} (${o.percent}%) ${tags}`.trimEnd();
          })
          .join("\n");
        return { content: [{ type: "text", text: sanitize(`${header}\n${opts}`) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-poll-results");
      }
    },
  );

  server.registerTool(
    "telegram-get-poll-voters",
    {
      description: "List users who voted for specific poll options (public polls only, paginated).",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        messageId: z.number().int().positive().describe("Message ID of the poll"),
        optionIndex: z
          .number()
          .int()
          .min(0)
          .max(9)
          .optional()
          .describe("Zero-based option index to filter by. Omit to get all voters"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max voters to return"),
        offset: z.string().optional().describe("Pagination offset from previous call"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId, optionIndex, limit, offset }) => {
      const limited = trackCall("telegram-get-poll-voters");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getPollVoters(chatId, messageId, { optionIndex, limit, offset });
        logDuration("telegram-get-poll-voters", start);
        if (r.voters.length === 0) return { content: [{ type: "text", text: "No voters yet." }] };
        const lines: string[] = [
          `${r.total} total voters${r.nextOffset ? ` (more available; nextOffset=${r.nextOffset})` : ""}`,
        ];
        for (const v of r.voters) {
          const id = v.username ? `@${v.username}` : v.peerId;
          const opts = v.options.length ? ` → [${v.options.join(",")}]` : "";
          lines.push(`${v.name ?? id} (${v.peerId})${opts} at ${v.date}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-poll-voters");
      }
    },
  );

  server.registerTool(
    "telegram-get-recent-reactions",
    {
      description: "List the user's most recently used reaction emojis.",
      inputSchema: {
        limit: z.number().default(20).describe("Max reactions to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      const limited = trackCall("telegram-get-recent-reactions");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const reactions = await getTelegram().getRecentReactions(limit);
        logDuration("telegram-get-recent-reactions", start);
        if (reactions.length === 0) return { content: [{ type: "text", text: "No recent reactions." }] };
        return { content: [{ type: "text", text: sanitize(reactions.map((r) => r.emoji).join(" ")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-recent-reactions");
      }
    },
  );

  server.registerTool(
    "telegram-get-top-reactions",
    {
      description: "List globally popular reaction emojis (Telegram-curated trending).",
      inputSchema: {
        limit: z.number().default(20).describe("Max reactions to return"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      const limited = trackCall("telegram-get-top-reactions");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const reactions = await getTelegram().getTopReactions(limit);
        logDuration("telegram-get-top-reactions", start);
        if (reactions.length === 0) return { content: [{ type: "text", text: "No top reactions." }] };
        return { content: [{ type: "text", text: sanitize(reactions.map((r) => r.emoji).join(" ")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-top-reactions");
      }
    },
  );

  server.registerTool(
    "telegram-get-message-buttons",
    {
      description:
        "Read the inline keyboard / reply markup buttons attached to a message. Returns each button's row, column, type, label, and target (data, url, switch query, etc.).",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        messageId: z.number().describe("Message ID"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-get-message-buttons");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getMessageButtons(chatId, messageId);
        logDuration("telegram-get-message-buttons", start);
        if (r.buttons.length === 0) {
          return { content: [{ type: "text", text: `No buttons (markup: ${r.markupType}).` }] };
        }
        const lines = [`Markup: ${r.markupType}`];
        for (const b of r.buttons) {
          const target = b.url
            ? ` url=${b.url}`
            : b.data
              ? ` data=${b.data}`
              : b.switchQuery
                ? ` switch=${b.switchQuery}`
                : "";
          lines.push(`  [${b.row}.${b.col}] ${b.type}: ${b.label}${target}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-message-buttons");
      }
    },
  );

  server.registerTool(
    "telegram-get-message-read-participants",
    {
      description:
        "List who has read a message in a small group (≤100 members, ≤7 days old). Returns readers with userId and readAt timestamp. Does NOT work for channels or groups over 100 members (CHAT_TOO_BIG error).",
      inputSchema: {
        chatId: z.string().describe("Group chat ID or @username"),
        messageId: z.number().int().positive().describe("ID of the message to check read status for"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-get-message-read-participants");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getMessageReadParticipants(chatId, messageId);
        logDuration("telegram-get-message-read-participants", start);
        if (r.count === 0) return { content: [{ type: "text", text: "No readers recorded." }] };
        const lines = [`${r.count} reader(s) for message #${r.messageId}:`];
        for (const reader of r.readers) lines.push(`  ${reader.userId} at ${reader.readAt}`);
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-message-read-participants");
      }
    },
  );

  server.registerTool(
    "telegram-get-web-preview",
    {
      description:
        "Fetch Telegram's link preview metadata (title, description, site name) for a URL — same data shown when pasting a link into a chat.",
      inputSchema: {
        url: z
          .string()
          .url()
          .refine(
            (u) => {
              try {
                const p = new URL(u);
                if (p.protocol !== "http:" && p.protocol !== "https:") return false;
                const host = p.hostname
                  .toLowerCase()
                  .replace(/^\[|\]$/g, "")
                  .replace(/\.$/, "");
                if (
                  host === "localhost" ||
                  host.endsWith(".localhost") ||
                  /^0\./.test(host) ||
                  /^127\./.test(host) ||
                  host === "::1" ||
                  host === "::" ||
                  /^169\.254\./.test(host) ||
                  /^10\./.test(host) ||
                  /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
                  /^192\.168\./.test(host)
                ) {
                  return false;
                }
                return true;
              } catch {
                return false;
              }
            },
            { message: "URL must be public http(s); loopback / private / link-local addresses are not allowed" },
          )
          .describe("Public http(s) URL to preview"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ url }) => {
      const limited = trackCall("telegram-get-web-preview");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const p = await getTelegram().getWebPreview(url);
        logDuration("telegram-get-web-preview", start);
        if (!p) return { content: [{ type: "text", text: "No preview available." }] };
        const lines = [`Type: ${p.type}`];
        if (p.url) lines.push(`URL: ${p.url}`);
        if (p.siteName) lines.push(`Site: ${p.siteName}`);
        if (p.title) lines.push(`Title: ${p.title}`);
        if (p.description) lines.push(`Description: ${p.description}`);
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-web-preview");
      }
    },
  );

  server.registerTool(
    "telegram-get-outbox-read-date",
    {
      description:
        "Get when the recipient read your outgoing message in a private chat. Returns 'Not read yet' if unread. Errors if the recipient disabled read receipts (USER_PRIVACY_RESTRICTED).",
      inputSchema: {
        chatId: z.string().describe("Private chat ID or @username of the recipient"),
        messageId: z.number().int().positive().describe("ID of your outgoing message"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, messageId }) => {
      const limited = trackCall("telegram-get-outbox-read-date");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getOutboxReadDate(chatId, messageId);
        logDuration("telegram-get-outbox-read-date", start);
        return { content: [{ type: "text", text: r.readAt ? `Read at ${r.readAt}` : "Not read yet." }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-outbox-read-date");
      }
    },
  );

  server.registerTool(
    "telegram-get-my-role",
    {
      description:
        "Get the current user's role in a chat. Returns one of: creator, admin, member, banned, left (channels/supergroups), user (private chats), or unknown for unsupported entity types.",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId }) => {
      const limited = trackCall("telegram-get-my-role");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getMyRole(chatId);
        logDuration("telegram-get-my-role", start);
        return { content: [{ type: "text", text: sanitize(`${r.role} in ${r.chatName} (${r.chatId})`) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-my-role");
      }
    },
  );

  // ── v2.3.0 parity wave 1.2 — 15 read-only tools (admin/stats, boosts, stories, business, folders) ──

  server.registerTool(
    "telegram-get-admin-log",
    {
      description:
        "Get the admin action log (recent event history) of a supergroup or channel. Includes bans, edits, pins, and role changes.",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username (supergroup or channel)"),
        limit: z.number().int().min(1).max(100).default(20).describe("Number of events to return (1-100)"),
        q: z.string().optional().describe("Optional text filter for events"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, limit, q }) => {
      const limited = trackCall("telegram-get-admin-log");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const events = await getTelegram().getAdminLog(chatId, limit, q);
        logDuration("telegram-get-admin-log", start);
        if (events.length === 0) return { content: [{ type: "text", text: "No admin log events." }] };
        const text = events
          .map((e) => `[${e.date}] ${e.userName} (${e.userId}) — ${e.action}: ${e.details}`)
          .join("\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-admin-log");
      }
    },
  );

  server.registerTool(
    "telegram-get-broadcast-stats",
    {
      description:
        "Get broadcast channel statistics: followers, views/shares/reactions per post & story, notification percent, recent post interactions. Broadcast channels only (use telegram-get-megagroup-stats for supergroups). Admin rights required; some channels may require Telegram Premium to expose stats.",
      inputSchema: {
        chatId: z.string().describe("Broadcast channel ID or username"),
        includeGraphs: z
          .boolean()
          .default(false)
          .describe(
            "Include raw graph data for each series. Default false — returns only aggregate numbers + metadata",
          ),
        dark: z.boolean().default(false).describe("Prefer dark-theme palette when Telegram renders graphs"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, includeGraphs, dark }) => {
      const limited = trackCall("telegram-get-broadcast-stats");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const s = await getTelegram().getBroadcastStats(chatId, { dark, includeGraphs });
        logDuration("telegram-get-broadcast-stats", start);
        const lines = [
          `Period: ${new Date(s.period.minDate * 1000).toISOString()} → ${new Date(s.period.maxDate * 1000).toISOString()}`,
          `Followers: ${s.followers.current} (Δ ${s.followers.current - s.followers.previous})`,
          `Views/post: ${s.viewsPerPost.current}, Shares/post: ${s.sharesPerPost.current}, Reactions/post: ${s.reactionsPerPost.current}`,
          `Views/story: ${s.viewsPerStory.current}, Shares/story: ${s.sharesPerStory.current}, Reactions/story: ${s.reactionsPerStory.current}`,
          `Notifications enabled: ${s.enabledNotifications.percent}% (${s.enabledNotifications.part}/${s.enabledNotifications.total})`,
        ];
        if (s.recentPostsInteractions.length > 0) {
          lines.push(`\nRecent interactions (${s.recentPostsInteractions.length}):`);
          for (const r of s.recentPostsInteractions.slice(0, 10)) {
            const id = r.kind === "message" ? `msg #${r.msgId}` : `story #${r.storyId}`;
            lines.push(`  ${id}: ${r.views} views, ${r.forwards} forwards, ${r.reactions} reactions`);
          }
        }
        if (includeGraphs && s.graphs) {
          lines.push(`\nGraphs available: ${Object.keys(s.graphs).join(", ")}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-broadcast-stats");
      }
    },
  );

  server.registerTool(
    "telegram-get-megagroup-stats",
    {
      description:
        "Get supergroup statistics: members, messages, viewers, posters (current vs previous period), top posters/admins/inviters. Supergroups only (use telegram-get-broadcast-stats for broadcast channels). Admin rights required. Telegram rate-limits this endpoint to roughly 1 request per 30 minutes per channel — expect FLOOD_WAIT on rapid repeat calls.",
      inputSchema: {
        chatId: z.string().describe("Supergroup ID or username"),
        includeGraphs: z
          .boolean()
          .default(false)
          .describe("Include raw graph data. Default false — returns only aggregate numbers + top lists"),
        dark: z.boolean().default(false).describe("Prefer dark-theme palette when Telegram renders graphs"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, includeGraphs, dark }) => {
      const limited = trackCall("telegram-get-megagroup-stats");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const s = await getTelegram().getMegagroupStats(chatId, { dark, includeGraphs });
        logDuration("telegram-get-megagroup-stats", start);
        const lines = [
          `Period: ${new Date(s.period.minDate * 1000).toISOString()} → ${new Date(s.period.maxDate * 1000).toISOString()}`,
          `Members: ${s.members.current}, Messages: ${s.messages.current}, Viewers: ${s.viewers.current}, Posters: ${s.posters.current}`,
        ];
        if (s.topPosters.length > 0) {
          lines.push(`\nTop posters (${s.topPosters.length}):`);
          for (const p of s.topPosters.slice(0, 10))
            lines.push(`  ${p.userId}: ${p.messages} msgs, ${p.avgChars} avg chars`);
        }
        if (s.topAdmins.length > 0) {
          lines.push(`\nTop admins (${s.topAdmins.length}):`);
          for (const a of s.topAdmins.slice(0, 10))
            lines.push(`  ${a.userId}: ${a.deleted} del, ${a.kicked} kick, ${a.banned} ban`);
        }
        if (s.topInviters.length > 0) {
          lines.push(`\nTop inviters (${s.topInviters.length}):`);
          for (const i of s.topInviters.slice(0, 10)) lines.push(`  ${i.userId}: ${i.invitations} invites`);
        }
        if (includeGraphs && s.graphs) {
          lines.push(`\nGraphs available: ${Object.keys(s.graphs).join(", ")}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-megagroup-stats");
      }
    },
  );

  server.registerTool(
    "telegram-get-my-boosts",
    {
      description:
        "List the user's premium boost slots. Each entry includes slot index, the peer it currently boosts (if any), the date the boost was applied, expiration timestamp, and cooldownUntilDate (when a slot can be reassigned). Premium users have multiple slots; non-Premium users typically have a single slot.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-my-boosts");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getMyBoosts();
        logDuration("telegram-get-my-boosts", start);
        if (r.count === 0) return { content: [{ type: "text", text: "No boost slots." }] };
        const lines = [`${r.count} boost slot(s):`];
        for (const b of r.myBoosts) {
          const peer = b.peer ? `${b.peer.kind}:${b.peer.id}` : "(unassigned)";
          const cd = b.cooldownUntilDate ? `, cooldown until ${b.cooldownUntilDate}` : "";
          lines.push(`  slot ${b.slot}: ${peer} since ${b.date}, expires ${b.expires}${cd}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-my-boosts");
      }
    },
  );

  server.registerTool(
    "telegram-get-boosts-status",
    {
      description:
        "Fetch the boost status of a channel/supergroup. Returns current boost level, total boosts, progress to next level, giftBoosts, premiumAudience ratio, public boostUrl, and whether the current user is boosting (myBoost + myBoostSlots). Also includes any prepaidGiveaways attached to the chat.",
      inputSchema: {
        chatId: z.string().describe("Channel or supergroup to query — id or @username"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId }) => {
      const limited = trackCall("telegram-get-boosts-status");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const s = await getTelegram().getBoostsStatus(chatId);
        logDuration("telegram-get-boosts-status", start);
        const lines = [
          `Level: ${s.level} (${s.boosts} boosts)`,
          `Progress: ${s.currentLevelBoosts}${s.nextLevelBoosts != null ? ` / ${s.nextLevelBoosts}` : ""}`,
          `Boost URL: ${s.boostUrl}`,
        ];
        if (s.giftBoosts != null) lines.push(`Gift boosts: ${s.giftBoosts}`);
        if (s.premiumAudience) {
          lines.push(`Premium audience: ${s.premiumAudience.part}/${s.premiumAudience.total}`);
        }
        if (s.myBoost) lines.push(`I'm boosting (slots: ${s.myBoostSlots?.join(", ") ?? "?"})`);
        if (s.prepaidGiveaways && s.prepaidGiveaways.length > 0) {
          lines.push(`\nPrepaid giveaways (${s.prepaidGiveaways.length}):`);
          for (const g of s.prepaidGiveaways) {
            const detail = g.kind === "premium" ? `${g.months}mo premium` : `${g.stars} stars`;
            lines.push(`  ${g.id}: ${g.quantity}× ${detail} (boosts: ${g.boosts ?? "?"})`);
          }
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-boosts-status");
      }
    },
  );

  server.registerTool(
    "telegram-get-boosts-list",
    {
      description:
        "List the boosts applied to a channel/supergroup. Returns paginated boost entries with id, userId (or undefined for anonymous gift boosts), date, expires, flags (gift, giveaway, unclaimed), optional giveawayMsgId, usedGiftSlug, multiplier, and stars. Requires channel admin permissions. Supports pagination via nextOffset and an optional gifts filter to show only gift boosts.",
      inputSchema: {
        chatId: z.string().describe("Channel or supergroup to query — id or @username"),
        gifts: z.boolean().optional().describe("If true, return only gift boosts"),
        offset: z.string().optional().describe("Pagination cursor returned as nextOffset from the previous call"),
        limit: z.number().int().min(1).max(100).default(50).describe("Max boosts per page (1-100, default 50)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, gifts, offset, limit }) => {
      const limited = trackCall("telegram-get-boosts-list");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getBoostsList(chatId, { gifts, offset, limit });
        logDuration("telegram-get-boosts-list", start);
        if (r.boosts.length === 0) return { content: [{ type: "text", text: "No boosts." }] };
        const lines = [
          `${r.count} total boosts${r.nextOffset ? ` (more available; nextOffset=${r.nextOffset})` : ""}:`,
        ];
        for (const b of r.boosts) {
          const flags = [b.gift ? "gift" : "", b.giveaway ? "giveaway" : "", b.unclaimed ? "unclaimed" : ""]
            .filter(Boolean)
            .join(",");
          const tag = flags ? ` [${flags}]` : "";
          const x = b.multiplier && b.multiplier > 1 ? ` ×${b.multiplier}` : "";
          lines.push(`  ${b.id}: user=${b.userId ?? "anon"} from ${b.date} until ${b.expires}${x}${tag}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-boosts-list");
      }
    },
  );

  server.registerTool(
    "telegram-get-all-stories",
    {
      description:
        "Fetch active stories from contacts/channels the user follows. Pagination via 'next' + 'state' — pass the returned state back on the next call with next:true to load more. Use hidden:true to read stories from muted/archived peers. Returns compact story metadata (id, date, expireDate, caption, mediaType, counters) without raw media blobs.",
      inputSchema: {
        next: z.boolean().optional().describe("Load the next page (use with state from a prior response)"),
        hidden: z.boolean().optional().describe("Fetch stories from hidden/archived peers instead of the main feed"),
        state: z.string().optional().describe("Pagination state token returned by a previous call"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ next, hidden, state }) => {
      const limited = trackCall("telegram-get-all-stories");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      if (next === true && !state) {
        return {
          content: [
            {
              type: "text",
              text: "'state' is required when 'next' is true — use the state token from a prior telegram-get-all-stories response",
            },
          ],
          isError: true as const,
        };
      }
      const start = Date.now();
      try {
        const r = await getTelegram().getAllStories({ next, hidden, state });
        logDuration("telegram-get-all-stories", start);
        const lines = [
          `State: ${r.state} (modified=${r.modified}, hasMore=${r.hasMore ?? false}, count=${r.count ?? "?"})`,
        ];
        if (r.stealthMode) {
          lines.push(
            `Stealth mode: active until ${r.stealthMode.activeUntilDate ?? "n/a"}, cooldown ${r.stealthMode.cooldownUntilDate ?? "n/a"}`,
          );
        }
        for (const ps of r.peerStories) {
          lines.push(`\nPeer ${ps.peer.kind}:${ps.peer.id} (maxRead=${ps.maxReadId ?? "n/a"}):`);
          for (const s of ps.stories) {
            const meta = [
              s.date ? `at ${s.date}` : "",
              s.mediaType ?? "",
              s.pinned ? "pinned" : "",
              s.public ? "public" : "",
            ]
              .filter(Boolean)
              .join(", ");
            const cap = s.caption ? `: ${s.caption.slice(0, 80)}` : "";
            lines.push(`  [#${s.id}] ${s.kind} (${meta})${cap}`);
          }
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-all-stories");
      }
    },
  );

  server.registerTool(
    "telegram-get-peer-stories",
    {
      description:
        "Fetch currently active stories posted by a specific peer (user/channel). Returns compact story metadata (id, date, expireDate, caption, mediaType, counters) without raw media blobs. Use telegram-download-media with the story id if you need media bytes.",
      inputSchema: {
        chatId: z.string().describe("Peer to fetch stories from — user/channel id or @username"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId }) => {
      const limited = trackCall("telegram-get-peer-stories");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getPeerStories(chatId);
        logDuration("telegram-get-peer-stories", start);
        if (!r) return { content: [{ type: "text", text: "No stories from this peer." }] };
        const lines = [
          `Peer ${r.peer.kind}:${r.peer.id} (maxRead=${r.maxReadId ?? "n/a"}), ${r.stories.length} story(ies):`,
        ];
        for (const s of r.stories) {
          const meta = [
            s.date ? `at ${s.date}` : "",
            s.mediaType ?? "",
            s.pinned ? "pinned" : "",
            s.public ? "public" : "",
          ]
            .filter(Boolean)
            .join(", ");
          const cap = s.caption ? `: ${s.caption.slice(0, 80)}` : "";
          const counters = s.viewsCount != null ? ` [${s.viewsCount} views, ${s.reactionsCount ?? 0} reactions]` : "";
          lines.push(`  [#${s.id}] ${s.kind} (${meta})${cap}${counters}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-peer-stories");
      }
    },
  );

  server.registerTool(
    "telegram-get-stories-by-id",
    {
      description:
        "Fetch specific stories from a peer by their numeric IDs. Useful for retrieving archived/pinned stories outside the active feed. Returns compact story metadata and optional pinnedToTop list. Pass up to 100 ids per request.",
      inputSchema: {
        chatId: z.string().describe("Peer to fetch stories from — user/channel id or @username"),
        ids: z.array(z.number().int().positive()).min(1).max(100).describe("Story IDs to fetch (1-100 per request)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, ids }) => {
      const limited = trackCall("telegram-get-stories-by-id");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getStoriesById(chatId, ids);
        logDuration("telegram-get-stories-by-id", start);
        const lines = [`${r.count} story(ies):`];
        if (r.pinnedToTop && r.pinnedToTop.length > 0) lines.push(`Pinned to top: ${r.pinnedToTop.join(", ")}`);
        for (const s of r.stories) {
          const meta = [
            s.date ? `at ${s.date}` : "",
            s.mediaType ?? "",
            s.pinned ? "pinned" : "",
            s.public ? "public" : "",
          ]
            .filter(Boolean)
            .join(", ");
          const cap = s.caption ? `: ${s.caption.slice(0, 80)}` : "";
          lines.push(`  [#${s.id}] ${s.kind} (${meta})${cap}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-stories-by-id");
      }
    },
  );

  server.registerTool(
    "telegram-get-story-views",
    {
      description:
        "List viewers of one of YOUR stories. Returns per-viewer entries (user id, view date, their reaction emoji if any), plus totals (viewsCount, forwardsCount, reactionsCount) and nextOffset for pagination. This only works for stories you posted. Some accounts (non-Premium, old stories) may not get a full viewer list.",
      inputSchema: {
        chatId: z.string().describe("Peer owning the story — usually 'me' or your own user id/@username"),
        storyId: z.number().int().positive().describe("Story ID to fetch viewers for"),
        q: z.string().optional().describe("Filter viewers by name substring"),
        justContacts: z.boolean().optional().describe("Return only contacts"),
        reactionsFirst: z.boolean().optional().describe("Sort viewers who reacted first"),
        forwardsFirst: z.boolean().optional().describe("Sort forwards/reposts first"),
        offset: z.string().optional().describe("Pagination cursor from previous call"),
        limit: z.number().int().min(1).max(100).default(50).describe("Max viewers per page (1-100)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, storyId, q, justContacts, reactionsFirst, forwardsFirst, offset, limit }) => {
      const limited = trackCall("telegram-get-story-views");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getStoryViewsList(chatId, {
          id: storyId,
          q,
          justContacts,
          reactionsFirst,
          forwardsFirst,
          offset,
          limit,
        });
        logDuration("telegram-get-story-views", start);
        const lines = [
          `Story #${storyId}: ${r.count} viewers (${r.viewsCount} views, ${r.forwardsCount} forwards, ${r.reactionsCount} reactions)${r.nextOffset ? `, nextOffset=${r.nextOffset}` : ""}`,
        ];
        for (const v of r.views) {
          if (v.kind === "user") {
            const reaction = v.reaction ? ` ${v.reaction}` : "";
            const blocked = v.blocked ? " [blocked]" : "";
            lines.push(`  user ${v.userId} at ${v.date}${reaction}${blocked}`);
          } else if (v.kind === "publicForward") {
            lines.push(`  forward to ${v.peer ? `${v.peer.kind}:${v.peer.id}` : "?"} (msg ${v.messageId ?? "?"})`);
          } else {
            lines.push(`  repost from ${v.peer ? `${v.peer.kind}:${v.peer.id}` : "?"} (story ${v.storyId ?? "?"})`);
          }
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (/PREMIUM|PAYMENT_REQUIRED/i.test(msg)) {
          return {
            content: [{ type: "text", text: "Story view stats may require Telegram Premium." }],
            isError: true as const,
          };
        }
        return handleToolError(e, onRevoked, "telegram-get-story-views");
      }
    },
  );

  server.registerTool(
    "telegram-get-stories-archive",
    {
      description:
        "Fetch auto-archived (expired) stories from a peer's archive. Paginate via offsetId (pass last story id from previous page).",
      inputSchema: {
        chatId: z.string().default("me").describe("Peer whose archive to fetch (default: 'me')"),
        offsetId: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe("Pagination cursor — last story id from previous page (0 to start)"),
        limit: z.number().int().min(1).max(100).default(50).describe("Max stories to return (1-100, default 50)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, offsetId, limit }) => {
      const limited = trackCall("telegram-get-stories-archive");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getStoriesArchive(chatId, offsetId, limit);
        logDuration("telegram-get-stories-archive", start);
        if (r.stories.length === 0) return { content: [{ type: "text", text: "No archived stories." }] };
        const lines = [`${r.count} archived story(ies):`];
        for (const s of r.stories) {
          const meta = [s.date ? `at ${s.date}` : "", s.mediaType ?? ""].filter(Boolean).join(", ");
          const cap = s.caption ? `: ${s.caption.slice(0, 80)}` : "";
          lines.push(`  [#${s.id}] ${s.kind} (${meta})${cap}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-stories-archive");
      }
    },
  );

  server.registerTool(
    "telegram-export-story-link",
    {
      description: "Get a shareable t.me/… URL for a public story.",
      inputSchema: {
        chatId: z.string().describe("Peer who posted the story"),
        storyId: z.number().int().positive().describe("Story ID to get the link for"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ chatId, storyId }) => {
      const limited = trackCall("telegram-export-story-link");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().exportStoryLink(chatId, storyId);
        logDuration("telegram-export-story-link", start);
        return { content: [{ type: "text", text: sanitize(r.link) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-export-story-link");
      }
    },
  );

  server.registerTool(
    "telegram-get-suggested-folders",
    {
      description:
        "Get Telegram's suggested chat folders based on your chat list (e.g. 'Unread', 'Personal', 'Work'). Returns folder templates you can create with telegram-create-folder.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-suggested-folders");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const folders = await getTelegram().getSuggestedFolders();
        logDuration("telegram-get-suggested-folders", start);
        if (folders.length === 0) return { content: [{ type: "text", text: "No suggested folders." }] };
        const text = folders.map((f) => `${f.emoticon ?? ""} ${f.title}`.trim()).join("\n");
        return { content: [{ type: "text", text: sanitize(text) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-suggested-folders");
      }
    },
  );

  server.registerTool(
    "telegram-get-business-chat-links",
    {
      description:
        "List Telegram Business chat links configured for the account. Each entry includes the t.me/m/<slug> link, the prefilled message, optional title (admin-facing label), views count, and entityCount. Requires Telegram Business — returns empty list when none configured.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = trackCall("telegram-get-business-chat-links");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().getBusinessChatLinks();
        logDuration("telegram-get-business-chat-links", start);
        if (r.count === 0) return { content: [{ type: "text", text: "No business chat links configured." }] };
        const lines = [`${r.count} link(s):`];
        for (const l of r.links) {
          const label = l.title ? ` (${l.title})` : "";
          lines.push(`  ${l.link}${label} — ${l.views} views: ${l.message.slice(0, 100)}`);
        }
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-get-business-chat-links");
      }
    },
  );

  server.registerTool(
    "telegram-resolve-business-chat-link",
    {
      description:
        "Resolve a Telegram Business chat link by slug to see whose chat it opens and the pre-filled message.",
      inputSchema: {
        slug: z.string().min(1).describe("Link slug to resolve (from t.me/m/<slug>)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ slug }) => {
      const limited = trackCall("telegram-resolve-business-chat-link");
      if (limited) return limited;
      const err = await requireConnection();
      if (err) return { content: [{ type: "text", text: err }] };
      const start = Date.now();
      try {
        const r = await getTelegram().resolveBusinessChatLink(slug);
        logDuration("telegram-resolve-business-chat-link", start);
        const lines = [`Peer: ${r.peer.type}:${r.peer.id}`, `Entities: ${r.entityCount}`, `Message: ${r.message}`];
        return { content: [{ type: "text", text: sanitize(lines.join("\n")) }] };
      } catch (e) {
        return handleToolError(e, onRevoked, "telegram-resolve-business-chat-link");
      }
    },
  );
}
