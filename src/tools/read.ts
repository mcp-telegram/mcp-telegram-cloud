import { z } from "zod";
import { DOWNLOAD_CHUNK_BYTES, DOWNLOAD_LIMITS } from "../download-store.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  formatReactions,
  MAX_INLINE_MEDIA,
  READ_ONLY,
  renderDialog,
  renderMessage,
  sanitize,
  textResult,
} from "./helpers.js";

export const READ_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-status",
    description: "Check Telegram connection status",
    annotations: READ_ONLY,
    skipRequireConnection: true,
    handler: async (_args, { telegram }) => {
      // `skipRequireConnection` means the registry hands us the `undefined`
      // placeholder when no session is in the pool (see tool-registry.ts).
      // Reporting that state IS this tool's job, so answer instead of throwing.
      if (!telegram) return textResult("Not connected. No active Telegram session — please reconnect.");
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
    description:
      "Download media from a Telegram message. Images default to a thumbnail; full:true shows the full image inline. file:true prepares the original file (up to 8 MiB) for private download. Non-image media also returns a downloadId, authenticated browser URL, size and SHA-256, valid for 15 minutes. To retrieve bytes via MCP, repeat the same chatId/messageId with downloadId and offset (default 0): each response contains up to 64 KiB of base64, nextOffset and eof. Keep chunks out of the conversation context; decode them locally and verify the size and hash. Download IDs and URLs are not public sharing links.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().int().positive().describe("Message ID containing media"),
      file: z
        .boolean()
        .optional()
        .describe("Prepare the ORIGINAL file for private download instead of an inline image/thumbnail. Max 8 MiB."),
      downloadId: z
        .string()
        .regex(/^dl_[a-f0-9]{32}$/)
        .optional()
        .describe(
          "Previously returned private download ID. Reads a chunk of the cached file, not Telegram again. Keep the original chatId/messageId.",
        ),
      offset: z
        .number()
        .int()
        .nonnegative()
        .max(DOWNLOAD_LIMITS.fileBytes)
        .optional()
        .describe(
          "Byte offset when reading downloadId. Default 0; continue at nextOffset until eof. Retries at the same offset return identical bytes until expiry.",
        ),
      full: z
        .boolean()
        .optional()
        .describe(
          "Fetch the full-resolution image instead of a thumbnail. Default false. A full image can be hundreds of KB of base64 in the response — only set true when the thumbnail is not enough (e.g. reading fine text/details).",
        ),
    },
    annotations: READ_ONLY,
    skipConnectionFor: ({ downloadId }) => downloadId !== undefined,
    handler: async (
      { chatId, messageId, full, file, downloadId, offset },
      { telegram, downloads, userId, sessions, baseUrl, sourceAccountId, sourceAttachmentId },
    ) => {
      if (!downloads || !userId || !sessions || !baseUrl)
        throw new Error("Private download storage is unavailable on this server");
      if (downloadId !== undefined) {
        const chunk = downloads.chunk(userId, downloadId, chatId, messageId, offset ?? 0);
        if (!chunk) throw new Error("Download unavailable, expired or not yours. Prepare the original message again.");
        return { content: [{ type: "text", text: JSON.stringify(chunk) }], structuredContent: chunk };
      }
      if (offset !== undefined) throw new Error("offset requires downloadId");
      const accountId = sourceAccountId;
      if (accountId === undefined || !sourceAttachmentId)
        throw new Error("Source account was not bound to this tool call");
      const account = sessions.listAccounts(userId).find((a) => a.accountId === accountId);
      if (!account) throw new Error("Source account is unavailable");
      const canRead = () =>
        sessions.getAccountAttachmentId(userId, accountId) === sourceAttachmentId &&
        sessions
          .listAccounts(userId)
          .some(
            (a) =>
              a.accountId === accountId && a.telegramUserId === account.telegramUserId && a.addedAt === account.addedAt,
          );
      // An explicit capability check is essential: old core versions silently
      // ignore unknown options, so passing maxBytes to them would NOT be a cap.
      // SAFETY: this optional API is implemented by the next core release;
      // the installed old core lacks its declaration. We check for the method
      // below and fail closed before downloading if that capability is absent.
      const bounded = (
        telegram as unknown as {
          downloadMediaBounded?: (
            chatId: string,
            messageId: number,
            options: { maxBytes: number; thumb?: number; signal: AbortSignal },
          ) => Promise<{ buffer: Buffer; mimeType: string; isThumb: boolean; fileName?: string }>;
        }
      ).downloadMediaBounded;
      if (typeof bounded !== "function")
        throw new Error("Private downloads require an updated Telegram core with bounded media support");
      const signal = AbortSignal.timeout(60_000);
      let isThumb = false;
      const metadata = await downloads.prepare(userId, { chatId, messageId, canRead }, async (maxBytes) => {
        const result = await bounded.call(telegram, chatId, messageId, {
          maxBytes,
          signal,
          ...(!full && !file && { thumb: 0 }),
        });
        signal.throwIfAborted(); // never publish late work after the download deadline
        isThumb = result.isThumb;
        return result;
      });
      const url = `${baseUrl}/my/download/${metadata.downloadId}`;
      if (!file && metadata.mimeType.startsWith("image/")) {
        const cached = downloads.read(userId, metadata.downloadId);
        if (!cached) throw new Error("Download expired during preparation");
        const { bytes: buffer } = cached;
        const mimeType = metadata.mimeType;
        downloads.forget(userId, metadata.downloadId); // previews don't consume the snapshot quota
        if (buffer.length > MAX_INLINE_MEDIA) {
          return textResult(
            `Image too large for inline display (${(buffer.length / 1024).toFixed(0)} KB, limit ~950 KB). The image is a ${mimeType} file. Use file:true to download it privately without inline base64.`,
          );
        }
        const note = isThumb
          ? `Thumbnail preview (${(buffer.length / 1024).toFixed(0)} KB ${mimeType}). Pass full:true for the full-resolution image if you need finer detail.`
          : `Full image (${(buffer.length / 1024).toFixed(0)} KB ${mimeType}).`;
        return {
          content: [
            { type: "image", data: buffer.toString("base64"), mimeType },
            { type: "text", text: note },
          ],
        };
      }

      const result = { ...metadata, url, chunkBytes: DOWNLOAD_CHUNK_BYTES };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
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
      "For a channel post with comments enabled, returns the linked discussion-group info (discussionGroupId, discussionMsgId, unreadCount, topMessage). The comment thread is addressed by (discussionGroupId, discussionMsgId), the pair telegram-get-replies takes.",
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

  {
    name: "telegram-get-fact-check",
    description:
      "Get fact-check annotations on channel messages. Fact-checks are added by independent fact-checkers in supported countries. Most messages will show no fact-check.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (channel)"),
      messageIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(100)
        .describe("Message IDs to get fact-checks for (1-100)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageIds }, { telegram }) => {
      const r = await telegram.getFactCheck(chatId, messageIds);
      if (r.length === 0) return textResult("No fact-check data.");
      const lines = r.map((f) => {
        const country = f.country ? ` [${f.country}]` : "";
        const text = f.text ? `: ${f.text}` : f.needCheck ? " (needs check)" : " (none)";
        return `  #${f.messageId}${country}${text}`;
      });
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-groups-for-discussion",
    description:
      "List groups that can be linked as a discussion group to a channel you admin. Helper for channel admins setting up comment threads.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const r = await telegram.getGroupsForDiscussion();
      if (r.groups.length === 0) return textResult("No eligible groups.");
      const lines = r.groups.map((g) => {
        const u = g.username ? ` @${g.username}` : "";
        const c = g.participantsCount !== undefined ? ` [${g.participantsCount} members]` : "";
        return `  ${g.title} (${g.id})${u}${c}`;
      });
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-paid-reaction-privacy",
    description: "Get your current default paid reaction privacy setting (anonymous vs show name).",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const r = await telegram.getPaidReactionPrivacy();
      return textResult(`Default paid reaction privacy: ${r.private ? "anonymous" : "show name"}`);
    },
  },

  {
    name: "telegram-get-transcription",
    description:
      "Poll for an updated voice/video-note transcription result. Calls the same endpoint as telegram-transcribe-audio — Telegram guarantees idempotency (returns the same transcriptionId with updated text once processing completes).",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().int().positive().describe("Message ID of the voice or video note"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, messageId }, { telegram }) => {
      const r = await telegram.transcribeAudio(chatId, messageId);
      const trial = r.trialRemainsNum !== undefined ? `\nTrial remaining: ${r.trialRemainsNum}` : "";
      if (r.pending) {
        return textResult(`Transcription pending for #${messageId}\nTranscriptionId: ${r.transcriptionId}${trial}`);
      }
      return textResult(
        sanitize(
          `Transcription for #${messageId}:\nTranscriptionId: ${r.transcriptionId}\nStatus: complete${trial}\n\n${r.text}`,
        ),
      );
    },
  },

  {
    name: "telegram-get-suggested-folders",
    description:
      "Get Telegram's suggested chat folders based on your chat list (e.g. 'Unread', 'Personal', 'Work'). Returns folder templates only; nothing is created.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const folders = await telegram.getSuggestedFolders();
      if (folders.length === 0) return textResult("No suggested folders.");
      const text = folders.map((f) => `${f.emoticon ?? ""} ${f.title}`.trim()).join("\n");
      return textResult(sanitize(text));
    },
  },
];
