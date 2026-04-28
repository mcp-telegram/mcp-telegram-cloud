import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { z } from "zod";
import {
  type OnSessionRevoked,
  type OnToolCall,
  type RateLimitCheck,
  type RequireConnection,
  registerAllTools,
  type ToolDefinition,
} from "./tool-registry.js";

/** Remove unpaired UTF-16 surrogates that break JSON serialization */
function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Most cloud tools are read-only — annotate accordingly for ChatGPT/Claude */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Mark-as-read & similar safe state-change operations (not destructive, not read-only) */
const SAFE_WRITE = {
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

function renderMessage(m: {
  id: number;
  date: string | number;
  sender: string;
  text: string;
  media?: { type: string; fileName?: string };
  reactions?: { emoji: string; count: number; me: boolean }[];
}): string {
  const media = m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : "";
  return `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${media}${formatReactions(m.reactions)}`;
}

function renderDialog(d: {
  type: string;
  name: string;
  id: string | number;
  isBot?: boolean;
  isContact?: boolean;
  unreadCount: number;
}): string {
  const prefix = d.type === "group" ? "G" : d.type === "channel" ? "C" : "P";
  const botTag = d.isBot ? " [bot]" : "";
  const contactTag = d.type === "private" && d.isContact === false ? " [not in contacts]" : "";
  const unread = d.unreadCount > 0 ? ` [${d.unreadCount} unread]` : "";
  return `${prefix} ${d.name} (${d.id})${botTag}${contactTag}${unread}`;
}

function renderStoryMeta(s: {
  date?: string | number;
  mediaType?: string;
  pinned?: boolean;
  public?: boolean;
}): string {
  return [s.date ? `at ${s.date}` : "", s.mediaType ?? "", s.pinned ? "pinned" : "", s.public ? "public" : ""]
    .filter(Boolean)
    .join(", ");
}

/** Render a story snippet line: `[#id] kind (meta)[: caption]` (caption truncated to 80 chars). */
function renderStorySnippet(s: {
  id: number;
  kind: string;
  caption?: string;
  date?: string | number;
  mediaType?: string;
  pinned?: boolean;
  public?: boolean;
}): string {
  const cap = s.caption ? `: ${s.caption.slice(0, 80)}` : "";
  return `  [#${s.id}] ${s.kind} (${renderStoryMeta(s)})${cap}`;
}

/** Format a CompactPeer as `kind:id` (or fallback when peer is missing). */
function formatPeer(peer: { kind: string; id: string | number } | null | undefined, fallback = "?"): string {
  return peer ? `${peer.kind}:${peer.id}` : fallback;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const MAX_INLINE_MEDIA = 950_000; // ~950KB to stay under 1MB base64 limit

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-status",
    description: "Check Telegram connection status",
    annotations: READ_ONLY,
    skipRequireConnection: true,
    handler: async (_args, { telegram }) => {
      if (await telegram.ensureConnected()) {
        const me = await telegram.getMe();
        return textResult(`Connected as ${me.firstName ?? ""} (@${me.username ?? "unknown"}, id: ${me.id})`);
      }
      const reason = telegram.lastError ? ` Reason: ${telegram.lastError}` : "";
      return textResult(`Not connected.${reason}`);
    },
  },

  {
    name: "telegram-list-chats",
    description: "List Telegram chats",
    inputSchema: {
      limit: z.number().default(20).describe("Number of chats to return"),
      offsetDate: z.number().optional().describe("Unix timestamp offset for pagination"),
      filterType: z
        .enum(["private", "group", "channel", "contact_requests"])
        .optional()
        .describe("Filter by chat type. 'contact_requests' shows only private chats from non-contacts"),
    },
    annotations: READ_ONLY,
    handler: async ({ limit, offsetDate, filterType }, { telegram }) => {
      const dialogs = await telegram.getDialogs(limit, offsetDate, filterType);
      const text = dialogs.map(renderDialog).join("\n");
      return textResult(sanitize(text) || "No chats");
    },
  },

  {
    name: "telegram-read-messages",
    description: "Read recent messages from a Telegram chat",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      limit: z.number().default(10).describe("Number of messages to return"),
      offsetId: z.number().optional().describe("Message ID to start from (for pagination)"),
      minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
      maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, limit, offsetId, minDate, maxDate }, { telegram }) => {
      const messages = await telegram.getMessages(chatId, limit, offsetId, minDate, maxDate);
      const text = messages.map(renderMessage).join("\n\n");
      return textResult(sanitize(text) || "No messages");
    },
  },

  {
    name: "telegram-search-chats",
    description: "Search for Telegram chats/users/channels by name or username",
    inputSchema: {
      query: z.string().describe("Search query (name or username)"),
      limit: z.number().default(10).describe("Max results"),
    },
    annotations: READ_ONLY,
    handler: async ({ query, limit }, { telegram }) => {
      const results = await telegram.searchChats(query, limit);
      const text = results
        .map(
          (c) =>
            `${c.type === "group" ? "G" : c.type === "channel" ? "C" : "P"} ${c.name}${c.username ? ` (@${c.username})` : ""} (${c.id})${c.membersCount ? ` [${c.membersCount} members]` : ""}${c.description ? ` — ${c.description.split("\n")[0].slice(0, 100)}` : ""}`,
        )
        .join("\n");
      return textResult(sanitize(text) || "No results");
    },
  },

  {
    name: "telegram-search-global",
    description: "Search messages globally across all public Telegram chats and channels",
    inputSchema: {
      query: z.string().describe("Search text"),
      limit: z.number().default(20).describe("Max results"),
      minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
      maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
    },
    annotations: READ_ONLY,
    handler: async ({ query, limit, minDate, maxDate }, { telegram }) => {
      const messages = await telegram.searchGlobal(query, limit, minDate, maxDate);
      const text = messages
        .map(
          (m) =>
            `[#${m.id}] [${m.date}] [${m.chat.type === "channel" ? "C" : m.chat.type === "group" ? "G" : "P"} ${m.chat.name}${m.chat.username ? ` @${m.chat.username}` : ""}] ${m.sender}: ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}${formatReactions(m.reactions)}`,
        )
        .join("\n\n");
      return textResult(sanitize(text) || "No messages found");
    },
  },

  {
    name: "telegram-search-messages",
    description: "Search messages in a Telegram chat by text",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      query: z.string().describe("Search text"),
      limit: z.number().default(20).describe("Max results"),
      minDate: z.number().optional().describe("Unix timestamp: only messages after this date"),
      maxDate: z.number().optional().describe("Unix timestamp: only messages before this date"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, query, limit, minDate, maxDate }, { telegram }) => {
      const messages = await telegram.searchMessages(chatId, query, limit, minDate, maxDate);
      const text = messages.map(renderMessage).join("\n\n");
      return textResult(sanitize(text) || "No messages found");
    },
  },

  {
    name: "telegram-get-unread",
    description: "Get unread Telegram chats",
    inputSchema: {
      limit: z.number().default(20).describe("Number of unread chats to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ limit }, { telegram }) => {
      const dialogs = await telegram.getUnreadDialogs(limit);
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
      return textResult(sanitize(text) || "No unread chats");
    },
  },

  {
    name: "telegram-get-chat-members",
    description: "Get members/participants of a Telegram group or channel",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      limit: z.number().default(50).describe("Max number of members to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, limit }, { telegram }) => {
      const members = await telegram.getChatMembers(chatId, limit);
      const text = members.map((m) => `${m.name}${m.username ? ` (@${m.username})` : ""} [${m.id}]`).join("\n");
      return textResult(sanitize(text) || "No members found (may require joining the group)");
    },
  },

  {
    name: "telegram-get-contacts",
    description: "Get your Telegram contacts list",
    inputSchema: {
      limit: z.number().default(50).describe("Max number of contacts to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ limit }, { telegram }) => {
      const contacts = await telegram.getContacts(limit);
      const text = contacts
        .map((c) => `${c.name}${c.username ? ` (@${c.username})` : ""}${c.phone ? ` [+${c.phone}]` : ""} (${c.id})`)
        .join("\n");
      return textResult(sanitize(text) || "No contacts");
    },
  },

  {
    name: "telegram-get-chat-info",
    description: "Get detailed info about a Telegram chat",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId }, { telegram }) => {
      const info = await telegram.getChatInfo(chatId);
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
      return textResult(lines.join("\n"));
    },
  },

  {
    name: "telegram-get-contact-requests",
    description:
      "Get incoming messages from non-contacts (contact requests). Shows who messaged you without being in your contacts, with message preview",
    inputSchema: {
      limit: z.number().default(20).describe("Number of contact requests to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ limit }, { telegram }) => {
      const requests = await telegram.getContactRequests(limit);
      if (requests.length === 0) return textResult("No contact requests");
      const text = requests
        .map((r) => {
          const tag = r.isBot ? "[bot]" : "[user]";
          const username = r.username ? ` @${r.username}` : "";
          const unread = r.unreadCount > 0 ? ` [${r.unreadCount} unread]` : "";
          const preview = r.lastMessage ? `\n  > ${r.lastMessage.slice(0, 100)}` : "";
          return `${tag} ${r.name}${username} (${r.id})${unread}${preview}`;
        })
        .join("\n");
      return textResult(text);
    },
  },

  {
    name: "telegram-download-media",
    description: "Download media (photo, video, document) from a Telegram message and return it inline",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().describe("Message ID containing media"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const { buffer, mimeType } = await telegram.downloadMediaAsBuffer(chatId, messageId);

      if (mimeType.startsWith("image/")) {
        if (buffer.length > MAX_INLINE_MEDIA) {
          return textResult(
            `Image too large for inline display (${(buffer.length / 1024).toFixed(0)} KB, limit ~950 KB). The image is a ${mimeType} file. Try asking for a specific smaller photo or use telegram-read-messages to see the text content.`,
          );
        }
        return { content: [{ type: "image", data: buffer.toString("base64"), mimeType }] };
      }

      return textResult(
        `Media downloaded: ${mimeType}, ${(buffer.length / 1024).toFixed(0)} KB. Non-image media cannot be displayed inline.`,
      );
    },
  },

  {
    name: "telegram-list-topics",
    description:
      "List forum topics in a Telegram group with Topics enabled. Shows topic names, unread counts, and status",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username of a group with Topics enabled"),
      limit: z.number().default(100).describe("Max topics to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, limit }, { telegram }) => {
      const topics = await telegram.getForumTopics(chatId, limit);
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
      return textResult(sanitize(text) || "No topics found");
    },
  },

  {
    name: "telegram-read-topic-messages",
    description: "Read messages from a specific forum topic in a Telegram group",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      topicId: z.number().describe("Topic ID (get from telegram-list-topics)"),
      limit: z.number().default(20).describe("Number of messages to return"),
      offsetId: z.number().optional().describe("Message ID to start from (for pagination)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, topicId, limit, offsetId }, { telegram }) => {
      const messages = await telegram.getTopicMessages(chatId, topicId, limit, offsetId);
      const text = messages.map(renderMessage).join("\n\n");
      return textResult(sanitize(text) || "No messages in topic");
    },
  },

  {
    name: "telegram-get-reactions",
    description: "Get detailed reaction info for a message: which reactions, counts, and who reacted (when visible)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().describe("Message ID to get reactions for"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const result = await telegram.getMessageReactions(chatId, messageId);
      if (result.reactions.length === 0) return textResult(`No reactions on message ${messageId}`);
      const lines = result.reactions.map((r) => {
        const usersStr = r.users.length > 0 ? `: ${r.users.map((u) => u.name).join(", ")}` : "";
        return `${r.emoji} × ${r.count}${usersStr}`;
      });
      lines.push(`\nTotal: ${result.total} reactions`);
      return textResult(lines.join("\n"));
    },
  },

  {
    name: "telegram-get-profile",
    description: "Get detailed profile info of a Telegram user including bio, birthday, business info and more",
    inputSchema: {
      userId: z.string().describe("User ID or username"),
    },
    annotations: READ_ONLY,
    handler: async ({ userId }, { telegram }) => {
      const profile = await telegram.getProfile(userId);
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
      return textResult(lines.join("\n"));
    },
  },

  {
    name: "telegram-get-profile-photo",
    description: "Download profile photo of a Telegram user, group, or channel and return it inline",
    inputSchema: {
      entityId: z.string().describe("User/Chat/Channel ID or username"),
    },
    annotations: READ_ONLY,
    handler: async ({ entityId }, { telegram }) => {
      const result = await telegram.downloadProfilePhoto(entityId);
      if (!result || !("buffer" in result)) return textResult("No profile photo found");
      if (result.buffer.length > MAX_INLINE_MEDIA) {
        return textResult(
          `Profile photo too large for inline display (${(result.buffer.length / 1024).toFixed(0)} KB, limit ~950 KB).`,
        );
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
    },
  },

  {
    name: "telegram-mark-as-read",
    description: "Mark a Telegram chat as read. Marks all messages in the specified chat as read/seen",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
    },
    annotations: SAFE_WRITE,
    handler: async ({ chatId }, { telegram }) => {
      await telegram.markAsRead(chatId);
      return textResult(`Marked ${chatId} as read`);
    },
  },

  {
    name: "telegram-mute-chat",
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
    annotations: SAFE_WRITE,
    handler: async ({ chatId, muted, duration }, { telegram }) => {
      const MUTE_FOREVER = 2147483647;
      let muteUntil: number;
      if (!muted) {
        muteUntil = 0;
      } else if (duration !== undefined && duration > 0) {
        muteUntil = Math.min(Math.floor(Date.now() / 1000) + duration, MUTE_FOREVER);
      } else {
        muteUntil = MUTE_FOREVER;
      }
      await telegram.muteChat(chatId, muteUntil);
      const status = !muted
        ? "unmuted"
        : duration !== undefined && duration > 0
          ? `muted for ${duration}s`
          : "muted forever";
      return textResult(`Chat ${chatId} ${status}`);
    },
  },

  {
    name: "telegram-get-chat-folders",
    description: "Get list of your Telegram chat folders (filters) with their names and chat counts",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const folders = await telegram.getChatFolders();
      if (folders.length === 0) return textResult("No chat folders");
      const text = folders
        .map(
          (f) =>
            `[${f.id}] ${f.emoticon ? `${f.emoticon} ` : ""}${f.title} (${f.includeCount} chats, ${f.pinnedCount} pinned)`,
        )
        .join("\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-sessions",
    description:
      "Get list of all active Telegram sessions (logged-in devices) with device info, IP, and last active time",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const sessions = await telegram.getActiveSessions();
      if (sessions.length === 0) return textResult("No active sessions");
      const text = sessions
        .map(
          (s) =>
            `${s.current ? "→ " : "  "}${s.device} (${s.platform}) — ${s.appName} ${s.appVersion}\n    IP: ${s.ip} (${s.country}) | Last active: ${s.dateActive}${s.current ? " [CURRENT]" : ""}\n    Hash: ${s.hash}`,
        )
        .join("\n\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-invite-links",
    description:
      "Get list of invite links for a group or channel. By default returns links created by the current account",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      limit: z.number().default(20).describe("Max links to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, limit }, { telegram }) => {
      const links = await telegram.getInviteLinks(chatId, limit);
      if (links.length === 0) return textResult("No invite links");
      const text = links
        .map(
          (l) =>
            `${l.link}${l.title ? ` (${l.title})` : ""} — ${l.usageCount} uses${l.expired ? " [EXPIRED]" : ""}${l.revoked ? " [REVOKED]" : ""}`,
        )
        .join("\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-sticker-set",
    description:
      "Get all stickers from a sticker set by its short name. Returns each sticker with index and emoji. Use the index with telegram-send-sticker to send a specific sticker",
    inputSchema: {
      shortName: z
        .string()
        .describe(
          "Short name of the sticker set (e.g. 'AnimatedEmojis', 'HotCherry'). Find names via telegram-search-sticker-sets or from t.me/addstickers/<shortName> links",
        ),
    },
    annotations: READ_ONLY,
    handler: async ({ shortName }, { telegram }) => {
      const set = await telegram.getStickerSet(shortName);
      const lines = [`📦 ${set.title} (${set.shortName})`, `${set.count} stickers`, ""];
      for (let i = 0; i < set.stickers.length; i++) {
        lines.push(`[${i}] ${set.stickers[i].emoji}`);
      }
      lines.push("");
      lines.push(`Send a sticker: telegram-send-sticker(chatId, stickerSet="${set.shortName}", index=N)`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-search-sticker-sets",
    description:
      "Search for sticker sets by name or keyword. Returns matching sticker pack names that can be used with telegram-get-sticker-set",
    inputSchema: {
      query: z.string().describe("Search query (e.g. 'cat', 'love', 'pepe', 'anime')"),
    },
    annotations: READ_ONLY,
    handler: async ({ query }, { telegram }) => {
      const sets = await telegram.searchStickerSets(query);
      if (sets.length === 0) return textResult(`No sticker sets found for "${query}". Try different keywords.`);
      const lines: string[] = [`Found ${sets.length} sticker set(s) for "${query}":\n`];
      for (const set of sets) {
        lines.push(`• ${set.title} — ${set.count} stickers`);
        lines.push(`  Short name: ${set.shortName}`);
      }
      lines.push("");
      lines.push("Use telegram-get-sticker-set(shortName) to see individual stickers.");
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-installed-stickers",
    description:
      "List all sticker sets installed by the user. Returns pack names and short names for use with other sticker tools",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const sets = await telegram.getInstalledStickerSets();
      if (sets.length === 0) return textResult("No sticker sets installed.");
      const lines: string[] = [`${sets.length} installed sticker set(s):\n`];
      for (const set of sets) {
        lines.push(`• ${set.title} — ${set.count} stickers`);
        lines.push(`  Short name: ${set.shortName}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-recent-stickers",
    description: "Get recently used stickers. Returns each sticker with its list index and associated emoji",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const stickers = await telegram.getRecentStickers();
      if (stickers.length === 0) return textResult("No recent stickers.");
      const lines: string[] = [`${stickers.length} recent sticker(s):\n`];
      for (let i = 0; i < stickers.length; i++) {
        lines.push(`[${i}] ${stickers[i].emoji}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  // ── v2.2.0 parity wave 1 — 15 read-only tools ────────────────────────────

  {
    name: "telegram-get-message-link",
    description:
      "Get a t.me link to a specific message in a Telegram channel or supergroup. Private chats and basic groups don't expose shareable message links.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (channel or supergroup)"),
      messageId: z.number().int().positive().describe("ID of the message to link to"),
      thread: z.boolean().default(false).describe("Link to the message thread instead of the message itself"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId, thread }, { telegram }) => {
      const link = await telegram.getMessageLink(chatId, messageId, thread);
      return textResult(sanitize(link));
    },
  },

  {
    name: "telegram-get-replies",
    description: "Read reply thread / comments under a Telegram message (channel comments, group thread replies).",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().describe("Top-level message ID whose replies you want"),
      limit: z.number().default(20).describe("Max replies to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId, limit }, { telegram }) => {
      const replies = await telegram.getReplies(chatId, messageId, limit);
      const text = replies.map(renderMessage).join("\n\n");
      return textResult(sanitize(text) || "No replies");
    },
  },

  {
    name: "telegram-get-discussion-message",
    description:
      "For a channel post with comments enabled, returns the linked discussion-group info (discussionGroupId, discussionMsgId, unreadCount, topMessage). Use telegram-get-replies on (discussionGroupId, discussionMsgId) to read the comment thread.",
    inputSchema: {
      chatId: z.string().describe("Channel ID or @username that contains the post"),
      messageId: z.number().int().positive().describe("ID of the channel post to get discussion info for"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const d = await telegram.getDiscussionMessage(chatId, messageId);
      const lines: string[] = [
        `Discussion group: ${d.discussionGroupId}`,
        `Discussion message id: ${d.discussionMsgId}`,
        `Unread comments: ${d.unreadCount}`,
      ];
      if (d.topMessage) {
        lines.push(`Top message [#${d.topMessage.id}] (${d.topMessage.date}): ${d.topMessage.text ?? ""}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-saved-dialogs",
    description:
      "List Saved Messages sub-dialogs — Telegram's per-sender grouping of messages forwarded to your Saved Messages.",
    inputSchema: {
      limit: z.number().int().positive().default(20).describe("Max saved dialogs to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ limit }, { telegram }) => {
      const dialogs = await telegram.getSavedDialogs(limit);
      if (dialogs.length === 0) return textResult("No saved dialogs.");
      const text = dialogs.map((d) => `${d.peerTitle} (${d.peerId}) — last msg #${d.lastMsgId}`).join("\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-scheduled",
    description: "List scheduled (not yet sent) messages in a chat.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId }, { telegram }) => {
      const messages = await telegram.getScheduledMessages(chatId);
      if (messages.length === 0) return textResult("No scheduled messages.");
      const text = messages
        .map(
          (m) =>
            `[#${m.id}] [${m.date}] ${m.text}${m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : ""}`,
        )
        .join("\n\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-drafts",
    description: "List all draft messages across chats (unsent text the user typed and left).",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const drafts = await telegram.getAllDrafts();
      if (drafts.length === 0) return textResult("No drafts.");
      const text = drafts.map((d) => `${d.chatTitle} (${d.chatId}) [${d.date}]: ${d.text}`).join("\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-poll-results",
    description: "Get current results of a poll message (counts, percentages, your chosen options).",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().int().positive().describe("Message ID of the poll"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const p = await telegram.getPollResults(chatId, messageId);
      const header = `${p.question}${p.isQuiz ? " [quiz]" : ""}${p.isMulti ? " [multi]" : ""}${p.isClosed ? " [closed]" : ""} — ${p.totalVoters} voters`;
      const opts = p.options
        .map((o) => {
          const tags = [o.chosen ? "✓" : "", o.correct ? "★" : ""].filter(Boolean).join("");
          return `  [${o.index}] ${o.text} — ${o.votes} (${o.percent}%) ${tags}`.trimEnd();
        })
        .join("\n");
      return textResult(sanitize(`${header}\n${opts}`));
    },
  },

  {
    name: "telegram-get-poll-voters",
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
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId, optionIndex, limit, offset }, { telegram }) => {
      const r = await telegram.getPollVoters(chatId, messageId, { optionIndex, limit, offset });
      if (r.voters.length === 0) return textResult("No voters yet.");
      const lines: string[] = [
        `${r.total} total voters${r.nextOffset ? ` (more available; nextOffset=${r.nextOffset})` : ""}`,
      ];
      for (const v of r.voters) {
        const id = v.username ? `@${v.username}` : v.peerId;
        const opts = v.options.length ? ` → [${v.options.join(",")}]` : "";
        lines.push(`${v.name ?? id} (${v.peerId})${opts} at ${v.date}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-recent-reactions",
    description: "List the user's most recently used reaction emojis.",
    inputSchema: {
      limit: z.number().default(20).describe("Max reactions to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ limit }, { telegram }) => {
      const reactions = await telegram.getRecentReactions(limit);
      if (reactions.length === 0) return textResult("No recent reactions.");
      return textResult(sanitize(reactions.map((r) => r.emoji).join(" ")));
    },
  },

  {
    name: "telegram-get-top-reactions",
    description: "List globally popular reaction emojis (Telegram-curated trending).",
    inputSchema: {
      limit: z.number().default(20).describe("Max reactions to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ limit }, { telegram }) => {
      const reactions = await telegram.getTopReactions(limit);
      if (reactions.length === 0) return textResult("No top reactions.");
      return textResult(sanitize(reactions.map((r) => r.emoji).join(" ")));
    },
  },

  {
    name: "telegram-get-message-buttons",
    description:
      "Read the inline keyboard / reply markup buttons attached to a message. Returns each button's row, column, type, label, and target (data, url, switch query, etc.).",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().describe("Message ID"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const r = await telegram.getMessageButtons(chatId, messageId);
      if (r.buttons.length === 0) return textResult(`No buttons (markup: ${r.markupType}).`);
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
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-message-read-participants",
    description:
      "List who has read a message in a small group (≤100 members, ≤7 days old). Returns readers with userId and readAt timestamp. Does NOT work for channels or groups over 100 members (CHAT_TOO_BIG error).",
    inputSchema: {
      chatId: z.string().describe("Group chat ID or @username"),
      messageId: z.number().int().positive().describe("ID of the message to check read status for"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const r = await telegram.getMessageReadParticipants(chatId, messageId);
      if (r.count === 0) return textResult("No readers recorded.");
      const lines = [`${r.count} reader(s) for message #${r.messageId}:`];
      for (const reader of r.readers) lines.push(`  ${reader.userId} at ${reader.readAt}`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-web-preview",
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
    annotations: READ_ONLY,
    handler: async ({ url }, { telegram }) => {
      const p = await telegram.getWebPreview(url);
      if (!p) return textResult("No preview available.");
      const lines = [`Type: ${p.type}`];
      if (p.url) lines.push(`URL: ${p.url}`);
      if (p.siteName) lines.push(`Site: ${p.siteName}`);
      if (p.title) lines.push(`Title: ${p.title}`);
      if (p.description) lines.push(`Description: ${p.description}`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-outbox-read-date",
    description:
      "Get when the recipient read your outgoing message in a private chat. Returns 'Not read yet' if unread. Errors if the recipient disabled read receipts (USER_PRIVACY_RESTRICTED).",
    inputSchema: {
      chatId: z.string().describe("Private chat ID or @username of the recipient"),
      messageId: z.number().int().positive().describe("ID of your outgoing message"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const r = await telegram.getOutboxReadDate(chatId, messageId);
      return textResult(r.readAt ? `Read at ${r.readAt}` : "Not read yet.");
    },
  },

  {
    name: "telegram-get-my-role",
    description:
      "Get the current user's role in a chat. Returns one of: creator, admin, member, banned, left (channels/supergroups), user (private chats), or unknown for unsupported entity types.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId }, { telegram }) => {
      const r = await telegram.getMyRole(chatId);
      return textResult(sanitize(`${r.role} in ${r.chatName} (${r.chatId})`));
    },
  },

  // ── v2.3.0 parity wave 1.2 — 15 read-only tools (admin/stats, boosts, stories, business, folders) ──

  {
    name: "telegram-get-admin-log",
    description:
      "Get the admin action log (recent event history) of a supergroup or channel. Includes bans, edits, pins, and role changes.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (supergroup or channel)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Number of events to return (1-100)"),
      q: z.string().optional().describe("Optional text filter for events"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, limit, q }, { telegram }) => {
      const events = await telegram.getAdminLog(chatId, limit, q);
      if (events.length === 0) return textResult("No admin log events.");
      const text = events.map((e) => `[${e.date}] ${e.userName} (${e.userId}) — ${e.action}: ${e.details}`).join("\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-broadcast-stats",
    description:
      "Get broadcast channel statistics: followers, views/shares/reactions per post & story, notification percent, recent post interactions. Broadcast channels only (use telegram-get-megagroup-stats for supergroups). Admin rights required; some channels may require Telegram Premium to expose stats.",
    inputSchema: {
      chatId: z.string().describe("Broadcast channel ID or username"),
      includeGraphs: z
        .boolean()
        .default(false)
        .describe("Include raw graph data for each series. Default false — returns only aggregate numbers + metadata"),
      dark: z.boolean().default(false).describe("Prefer dark-theme palette when Telegram renders graphs"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, includeGraphs, dark }, { telegram }) => {
      const s = await telegram.getBroadcastStats(chatId, { dark, includeGraphs });
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
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-megagroup-stats",
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
    annotations: READ_ONLY,
    handler: async ({ chatId, includeGraphs, dark }, { telegram }) => {
      const s = await telegram.getMegagroupStats(chatId, { dark, includeGraphs });
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
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-my-boosts",
    description:
      "List the user's premium boost slots. Each entry includes slot index, the peer it currently boosts (if any), the date the boost was applied, expiration timestamp, and cooldownUntilDate (when a slot can be reassigned). Premium users have multiple slots; non-Premium users typically have a single slot.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const r = await telegram.getMyBoosts();
      if (r.count === 0) return textResult("No boost slots.");
      const lines = [`${r.count} boost slot(s):`];
      for (const b of r.myBoosts) {
        const cd = b.cooldownUntilDate ? `, cooldown until ${b.cooldownUntilDate}` : "";
        lines.push(
          `  slot ${b.slot}: ${formatPeer(b.peer, "(unassigned)")} since ${b.date}, expires ${b.expires}${cd}`,
        );
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-boosts-status",
    description:
      "Fetch the boost status of a channel/supergroup. Returns current boost level, total boosts, progress to next level, giftBoosts, premiumAudience ratio, public boostUrl, and whether the current user is boosting (myBoost + myBoostSlots). Also includes any prepaidGiveaways attached to the chat.",
    inputSchema: {
      chatId: z.string().describe("Channel or supergroup to query — id or @username"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId }, { telegram }) => {
      const s = await telegram.getBoostsStatus(chatId);
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
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-boosts-list",
    description:
      "List the boosts applied to a channel/supergroup. Returns paginated boost entries with id, userId (or undefined for anonymous gift boosts), date, expires, flags (gift, giveaway, unclaimed), optional giveawayMsgId, usedGiftSlug, multiplier, and stars. Requires channel admin permissions. Supports pagination via nextOffset and an optional gifts filter to show only gift boosts.",
    inputSchema: {
      chatId: z.string().describe("Channel or supergroup to query — id or @username"),
      gifts: z.boolean().optional().describe("If true, return only gift boosts"),
      offset: z.string().optional().describe("Pagination cursor returned as nextOffset from the previous call"),
      limit: z.number().int().min(1).max(100).default(50).describe("Max boosts per page (1-100, default 50)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, gifts, offset, limit }, { telegram }) => {
      const r = await telegram.getBoostsList(chatId, { gifts, offset, limit });
      if (r.boosts.length === 0) return textResult("No boosts.");
      const lines = [`${r.count} total boosts${r.nextOffset ? ` (more available; nextOffset=${r.nextOffset})` : ""}:`];
      for (const b of r.boosts) {
        const flags = [b.gift ? "gift" : "", b.giveaway ? "giveaway" : "", b.unclaimed ? "unclaimed" : ""]
          .filter(Boolean)
          .join(",");
        const tag = flags ? ` [${flags}]` : "";
        const x = b.multiplier && b.multiplier > 1 ? ` ×${b.multiplier}` : "";
        lines.push(`  ${b.id}: user=${b.userId ?? "anon"} from ${b.date} until ${b.expires}${x}${tag}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-all-stories",
    description:
      "Fetch active stories from contacts/channels the user follows. Pagination via 'next' + 'state' — pass the returned state back on the next call with next:true to load more. Use hidden:true to read stories from muted/archived peers. Returns compact story metadata (id, date, expireDate, caption, mediaType, counters) without raw media blobs.",
    inputSchema: {
      next: z.boolean().optional().describe("Load the next page (use with state from a prior response)"),
      hidden: z.boolean().optional().describe("Fetch stories from hidden/archived peers instead of the main feed"),
      state: z.string().optional().describe("Pagination state token returned by a previous call"),
    },
    annotations: READ_ONLY,
    preValidate: ({ next, state }) => {
      if (next === true && !state) {
        return {
          content: [
            {
              type: "text",
              text: "'state' is required when 'next' is true — use the state token from a prior telegram-get-all-stories response",
            },
          ],
          isError: true,
        };
      }
      return null;
    },
    handler: async ({ next, hidden, state }, { telegram }) => {
      const r = await telegram.getAllStories({ next, hidden, state });
      const lines = [
        `State: ${r.state} (modified=${r.modified}, hasMore=${r.hasMore ?? false}, count=${r.count ?? "?"})`,
      ];
      if (r.stealthMode) {
        lines.push(
          `Stealth mode: active until ${r.stealthMode.activeUntilDate ?? "n/a"}, cooldown ${r.stealthMode.cooldownUntilDate ?? "n/a"}`,
        );
      }
      for (const ps of r.peerStories) {
        lines.push(`\nPeer ${formatPeer(ps.peer)} (maxRead=${ps.maxReadId ?? "n/a"}):`);
        for (const s of ps.stories) lines.push(renderStorySnippet(s));
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-peer-stories",
    description:
      "Fetch currently active stories posted by a specific peer (user/channel). Returns compact story metadata (id, date, expireDate, caption, mediaType, counters) without raw media blobs. Use telegram-download-media with the story id if you need media bytes.",
    inputSchema: {
      chatId: z.string().describe("Peer to fetch stories from — user/channel id or @username"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId }, { telegram }) => {
      const r = await telegram.getPeerStories(chatId);
      if (!r) return textResult("No stories from this peer.");
      const lines = [`Peer ${formatPeer(r.peer)} (maxRead=${r.maxReadId ?? "n/a"}), ${r.stories.length} story(ies):`];
      for (const s of r.stories) {
        const counters = s.viewsCount != null ? ` [${s.viewsCount} views, ${s.reactionsCount ?? 0} reactions]` : "";
        lines.push(`${renderStorySnippet(s)}${counters}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-stories-by-id",
    description:
      "Fetch specific stories from a peer by their numeric IDs. Useful for retrieving archived/pinned stories outside the active feed. Returns compact story metadata and optional pinnedToTop list. Pass up to 100 ids per request.",
    inputSchema: {
      chatId: z.string().describe("Peer to fetch stories from — user/channel id or @username"),
      ids: z.array(z.number().int().positive()).min(1).max(100).describe("Story IDs to fetch (1-100 per request)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, ids }, { telegram }) => {
      const r = await telegram.getStoriesById(chatId, ids);
      const lines = [`${r.count} story(ies):`];
      if (r.pinnedToTop && r.pinnedToTop.length > 0) lines.push(`Pinned to top: ${r.pinnedToTop.join(", ")}`);
      for (const s of r.stories) lines.push(renderStorySnippet(s));
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-story-views",
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
    annotations: READ_ONLY,
    handler: async (
      { chatId, storyId, q, justContacts, reactionsFirst, forwardsFirst, offset, limit },
      { telegram },
    ) => {
      const r = await telegram.getStoryViewsList(chatId, {
        id: storyId,
        q,
        justContacts,
        reactionsFirst,
        forwardsFirst,
        offset,
        limit,
      });
      const lines = [
        `Story #${storyId}: ${r.count} viewers (${r.viewsCount} views, ${r.forwardsCount} forwards, ${r.reactionsCount} reactions)${r.nextOffset ? `, nextOffset=${r.nextOffset}` : ""}`,
      ];
      for (const v of r.views) {
        if (v.kind === "user") {
          const reaction = v.reaction ? ` ${v.reaction}` : "";
          const blocked = v.blocked ? " [blocked]" : "";
          lines.push(`  user ${v.userId} at ${v.date}${reaction}${blocked}`);
        } else if (v.kind === "publicForward") {
          lines.push(`  forward to ${formatPeer(v.peer)} (msg ${v.messageId ?? "?"})`);
        } else {
          lines.push(`  repost from ${formatPeer(v.peer)} (story ${v.storyId ?? "?"})`);
        }
      }
      return textResult(sanitize(lines.join("\n")));
    },
    onError: (e) => {
      const msg = (e as Error).message ?? "";
      if (/PREMIUM|PAYMENT_REQUIRED/i.test(msg)) {
        return { content: [{ type: "text", text: "Story view stats may require Telegram Premium." }], isError: true };
      }
      return null;
    },
  },

  {
    name: "telegram-get-stories-archive",
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
    annotations: READ_ONLY,
    handler: async ({ chatId, offsetId, limit }, { telegram }) => {
      const r = await telegram.getStoriesArchive(chatId, offsetId, limit);
      if (r.stories.length === 0) return textResult("No archived stories.");
      const lines = [`${r.count} archived story(ies):`];
      for (const s of r.stories) lines.push(renderStorySnippet(s));
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-export-story-link",
    description: "Get a shareable t.me/… URL for a public story.",
    inputSchema: {
      chatId: z.string().describe("Peer who posted the story"),
      storyId: z.number().int().positive().describe("Story ID to get the link for"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, storyId }, { telegram }) => {
      const r = await telegram.exportStoryLink(chatId, storyId);
      return textResult(sanitize(r.link));
    },
  },

  {
    name: "telegram-get-suggested-folders",
    description:
      "Get Telegram's suggested chat folders based on your chat list (e.g. 'Unread', 'Personal', 'Work'). Returns folder templates you can create with telegram-create-folder.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const folders = await telegram.getSuggestedFolders();
      if (folders.length === 0) return textResult("No suggested folders.");
      const text = folders.map((f) => `${f.emoticon ?? ""} ${f.title}`.trim()).join("\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-business-chat-links",
    description:
      "List Telegram Business chat links configured for the account. Each entry includes the t.me/m/<slug> link, the prefilled message, optional title (admin-facing label), views count, and entityCount. Requires Telegram Business — returns empty list when none configured.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const r = await telegram.getBusinessChatLinks();
      if (r.count === 0) return textResult("No business chat links configured.");
      const lines = [`${r.count} link(s):`];
      for (const l of r.links) {
        const label = l.title ? ` (${l.title})` : "";
        lines.push(`  ${l.link}${label} — ${l.views} views: ${l.message.slice(0, 100)}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-resolve-business-chat-link",
    description: "Resolve a Telegram Business chat link by slug to see whose chat it opens and the pre-filled message.",
    inputSchema: {
      slug: z.string().min(1).describe("Link slug to resolve (from t.me/m/<slug>)"),
    },
    annotations: READ_ONLY,
    handler: async ({ slug }, { telegram }) => {
      const r = await telegram.resolveBusinessChatLink(slug);
      const lines = [`Peer: ${r.peer.type}:${r.peer.id}`, `Entities: ${r.entityCount}`, `Message: ${r.message}`];
      return textResult(sanitize(lines.join("\n")));
    },
  },
];

/**
 * Register read-only Telegram tools + safe state-change tools on the given MCP server.
 * Write operations (send, edit, delete, forward, pin, etc.) are intentionally excluded.
 *
 * Backward-compatible thin wrapper around the data-driven registry. New tools should be
 * added as entries to READ_ONLY_TOOLS rather than as new function calls here.
 */
export function registerReadOnlyTools(
  server: McpServer,
  getTelegram: () => TelegramService,
  requireConnection: RequireConnection,
  onSessionRevoked?: OnSessionRevoked,
  onToolCall?: OnToolCall,
  checkRateLimit?: RateLimitCheck,
): void {
  registerAllTools(server, READ_ONLY_TOOLS, {
    getTelegram,
    requireConnection,
    onSessionRevoked,
    onToolCall,
    checkRateLimit,
  });
}
