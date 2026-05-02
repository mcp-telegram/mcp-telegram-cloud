import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import {
  DESTRUCTIVE,
  errorResult,
  formatPeer,
  READ_ONLY,
  renderGroupCallParticipant,
  sanitize,
  textResult,
  WRITE,
} from "./_helpers.js";

export const MISC_TOOLS: ToolDefinition[] = [
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

  {
    name: "telegram-send-sticker",
    description:
      "Send a sticker from a sticker set to a chat. First use telegram-get-sticker-set to browse available stickers and find the index",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      stickerSet: z.string().min(1).describe("Short name of the sticker set (e.g. 'HotCherry')"),
      index: z
        .number()
        .int()
        .nonnegative()
        .describe("Index of the sticker in the set (0-based, get from telegram-get-sticker-set)"),
      replyTo: z.number().int().optional().describe("Message ID to reply to"),
    },
    annotations: WRITE,
    handler: async ({ chatId, stickerSet, index, replyTo }, { telegram }) => {
      await telegram.sendSticker(chatId, stickerSet, index, replyTo);
      return textResult(sanitize(`Sticker sent from "${stickerSet}" [${index}] to ${chatId}`));
    },
  },

  {
    name: "telegram-get-state",
    description:
      "Initialize the polling cursor by fetching the current Telegram updates state {pts, qts, date, seq, unreadCount}. Call once before telegram-get-updates; then persist {pts, qts, date} in your agent state and feed them into telegram-get-updates. The MCP server does NOT store the cursor — you do.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const s = await telegram.getUpdatesState();
      return textResult(`pts=${s.pts} qts=${s.qts} date=${s.date} seq=${s.seq} unreadCount=${s.unreadCount}`);
    },
  },

  {
    name: "telegram-get-updates",
    description:
      "Fetch new messages, deleted messages, and other updates since a previously-known {pts, qts, date} cursor (from telegram-get-state or a prior call). Returns compact newMessages[], deletedMessageIds[], otherUpdates[] (className only), and the new cursor state. isFinal=false means more updates are queued — call again with the returned state. If Telegram reports the gap is too long, a fallback hint is returned suggesting to resync via telegram-read-messages per chat. Cursor is stateless — the agent must persist {pts, qts, date} between calls.",
    inputSchema: {
      pts: z.number().int().describe("Last known pts (from telegram-get-state or prior telegram-get-updates)"),
      qts: z.number().int().describe("Last known qts (secret-chat / encrypted stream cursor; 0 if unknown)"),
      date: z.number().int().describe("Last known date (unix seconds from prior state)"),
      ptsLimit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Max updates per batch (default 100, capped at 1000)"),
      ptsTotalLimit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Max total updates across paginated slices (default 1000, capped at 1000)"),
    },
    annotations: READ_ONLY,
    handler: async ({ pts, qts, date, ptsLimit, ptsTotalLimit }, { telegram }) => {
      const d = await telegram.getUpdates({ pts, qts, date, ptsLimit, ptsTotalLimit });
      const lines = [
        `state: pts=${d.state.pts} qts=${d.state.qts} date=${d.state.date} seq=${d.state.seq}${d.state.unreadCount !== undefined ? ` unread=${d.state.unreadCount}` : ""}`,
        `isFinal=${d.isFinal} newMessages=${d.newMessages.length} deletedGroups=${d.deletedMessageIds.length} otherUpdates=${d.otherUpdates.length}`,
      ];
      if (d.fallback) lines.push(`fallback=${d.fallback.kind}: ${d.fallback.suggestedAction}`);
      for (const m of d.newMessages.slice(0, 50)) {
        lines.push(
          `  [#${m.id}] ${formatPeer(m.peer)} ${m.fromId ? `from ${formatPeer(m.fromId)} ` : ""}date=${m.date}: ${m.text}`,
        );
      }
      if (d.newMessages.length > 50) lines.push(`  ... (${d.newMessages.length - 50} more)`);
      for (const g of d.deletedMessageIds.slice(0, 20)) {
        lines.push(`  deleted in ${formatPeer(g.peer ?? null)}: [${g.messageIds.join(",")}]`);
      }
      if (d.deletedMessageIds.length > 20) {
        lines.push(`  ... (${d.deletedMessageIds.length - 20} more deleted groups)`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-channel-updates",
    description:
      "Fetch new messages and updates for a single channel/supergroup since a known per-channel pts cursor. Separate from the global cursor used by telegram-get-updates. Returns compact newMessages[], otherUpdates[], and new {pts, isFinal, timeout?}. If the channel gap is too long, Telegram returns a dialog snapshot — this tool forwards it and hints to resync via telegram-read-messages. Cursor is stateless — the agent stores pts.",
    inputSchema: {
      chatId: z.string().describe("Channel or supergroup ID or username"),
      pts: z.number().int().describe("Last known per-channel pts"),
      limit: z.number().int().positive().optional().describe("Max updates per batch (default 100)"),
      force: z
        .boolean()
        .optional()
        .describe("Force request updates even if the client hasn't processed previous ones (rarely needed)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, pts, limit, force }, { telegram }) => {
      const d = await telegram.getChannelUpdates(chatId, { pts, limit, force });
      const lines = [
        `channel=${d.channelId} pts=${d.pts} isFinal=${d.isFinal}${d.timeout !== undefined ? ` timeout=${d.timeout}` : ""}`,
        `newMessages=${d.newMessages.length} otherUpdates=${d.otherUpdates.length}`,
      ];
      if (d.fallback) lines.push(`fallback=${d.fallback.kind}: ${d.fallback.suggestedAction}`);
      for (const m of d.newMessages.slice(0, 50)) {
        lines.push(`  [#${m.id}] ${m.fromId ? `from ${formatPeer(m.fromId)} ` : ""}date=${m.date}: ${m.text}`);
      }
      if (d.newMessages.length > 50) lines.push(`  ... (${d.newMessages.length - 50} more)`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-inline-query",
    description:
      "Query an inline bot (like @gif, @bing) in a chat context and return the compact result list. Returns queryId, cacheTime, and results[{id,type,title?,description?,url?}]. The queryId is typically valid for ~60s. Bot must be a real bot account.",
    inputSchema: {
      bot: z.string().describe("Inline bot username (e.g. @gif) or numeric user ID"),
      chatId: z.string().describe("Chat ID or username providing context for the inline query"),
      query: z.string().describe("Query text the bot should resolve (may be empty string)"),
      offset: z
        .string()
        .optional()
        .describe("Pagination offset returned by a previous call as nextOffset (empty string on first call)"),
    },
    annotations: READ_ONLY,
    handler: async ({ bot, chatId, query, offset }, { telegram }) => {
      const r = await telegram.getInlineBotResults(bot, chatId, query, offset);
      const lines = [
        `queryId=${r.queryId} cacheTime=${r.cacheTime}${r.gallery ? " [gallery]" : ""}${r.nextOffset ? ` nextOffset=${r.nextOffset}` : ""}`,
        `results: ${r.results.length}`,
      ];
      for (const item of r.results.slice(0, 50)) {
        const title = item.title ? ` "${item.title}"` : "";
        const desc = item.description ? ` — ${item.description}` : "";
        const url = item.url ? ` (${item.url})` : "";
        lines.push(`  [${item.id}] ${item.type}${title}${desc}${url}`);
      }
      if (r.results.length > 50) lines.push(`  ... (${r.results.length - 50} more)`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-quick-replies",
    description:
      "Fetch the list of quick-reply shortcuts configured for the user account (messages.GetQuickReplies). Each entry has {shortcutId, shortcut, topMessage, count} — use the shortcutId with telegram-get-quick-reply-messages to inspect the stored messages. Optional `hash` implements Telegram's hash-based diff: pass the last-known aggregate hash as a decimal string and the server may respond with notModified=true if nothing changed.",
    inputSchema: {
      hash: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe("Aggregate hash from a previous response (decimal string); omit for a fresh fetch"),
    },
    annotations: READ_ONLY,
    requiresEnv: "MCP_TELEGRAM_ENABLE_QUICK_REPLIES",
    handler: async ({ hash }, { telegram }) => {
      const r = await telegram.getQuickReplies(hash);
      if (r.notModified) return textResult("notModified");
      const list = r.quickReplies ?? [];
      if (list.length === 0) return textResult("No quick-reply shortcuts.");
      const lines = list.map(
        (q) => `  [${q.shortcutId}] ${q.shortcut} — ${q.count} message(s), topMessage=${q.topMessage}`,
      );
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-quick-reply-messages",
    description:
      "Fetch messages stored under a quick-reply shortcut (messages.GetQuickReplyMessages). Use `shortcutId` from telegram-get-quick-replies. Optional `ids` narrows to specific message ids within the shortcut. Optional `hash` implements Telegram's hash-based diff: pass the last-known aggregate hash as a decimal string — the server may respond with {notModified:true, count} if nothing changed.",
    inputSchema: {
      shortcutId: z.number().int().nonnegative().describe("Shortcut id from telegram-get-quick-replies"),
      ids: z
        .array(z.number().int().nonnegative())
        .optional()
        .describe("Optional list of message ids to fetch within the shortcut"),
      hash: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe("Aggregate hash from a previous response (decimal string); omit for a fresh fetch"),
    },
    annotations: READ_ONLY,
    requiresEnv: "MCP_TELEGRAM_ENABLE_QUICK_REPLIES",
    handler: async ({ shortcutId, ids, hash }, { telegram }) => {
      const r = await telegram.getQuickReplyMessages(shortcutId, { ids, hash });
      if (r.notModified) return textResult(`notModified${r.count !== undefined ? ` count=${r.count}` : ""}`);
      const messages = r.messages ?? [];
      if (messages.length === 0) return textResult(`No messages in shortcut #${shortcutId}.`);
      const lines = [`shortcut=${shortcutId} count=${r.count ?? messages.length}`];
      for (const m of messages) {
        const svc = m.isService ? " [service]" : "";
        const reply = m.replyToMsgId !== undefined ? ` reply→#${m.replyToMsgId}` : "";
        const from = m.fromId ? ` from ${formatPeer(m.fromId)}` : "";
        lines.push(`  [#${m.id}] date=${m.date}${from}${reply}${svc}: ${m.text}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-group-call",
    description:
      "Fetch metadata + an optional initial slice of participants for the active group call (voice/video chat) attached to a chat (phone.GetGroupCall). Returns call info (id, accessHash, participantsCount, title, scheduleDate, recordStartDate, streamDcId, flags) plus a participant slice (peer, date, muted/left/self flags, source, volume, video/presentation indicators) and participantsNextOffset. Pass limit:0 (default) for metadata only. Cloud requires MCP_TELEGRAM_ENABLE_GROUP_CALLS=1 (set on this server).",
    inputSchema: {
      chat: z
        .string()
        .describe(
          "Group/supergroup/channel that currently has an active group call — id, @username, or display name fragment",
        ),
      limit: z
        .number()
        .int()
        .min(0)
        .max(500)
        .optional()
        .describe(
          "Max participants to include (default 0 — metadata only; use telegram-get-group-call-participants for pagination)",
        ),
    },
    annotations: READ_ONLY,
    requiresEnv: "MCP_TELEGRAM_ENABLE_GROUP_CALLS",
    handler: async ({ chat, limit }, { telegram }) => {
      const r = await telegram.getGroupCall(chat, { limit });
      const c = r.call;
      const lines: string[] = [];
      if (c.kind === "active") {
        lines.push(
          `call id=${c.id} accessHash=${c.accessHash} participants=${c.participantsCount} version=${c.version}${c.title ? ` title="${c.title}"` : ""}`,
        );
        if (c.scheduleDate !== undefined) lines.push(`scheduled=${c.scheduleDate}`);
        if (c.recordStartDate !== undefined) lines.push(`recordingSince=${c.recordStartDate}`);
        if (c.streamDcId !== undefined) lines.push(`streamDcId=${c.streamDcId}`);
        if (c.unmutedVideoCount !== undefined) {
          lines.push(`unmutedVideo=${c.unmutedVideoCount}/${c.unmutedVideoLimit}`);
        }
        const callFlags = [
          c.joinMuted ? "joinMuted" : "",
          c.canChangeJoinMuted ? "canChangeJoinMuted" : "",
          c.recordVideoActive ? "recordingVideo" : "",
          c.rtmpStream ? "rtmp" : "",
          c.listenersHidden ? "listenersHidden" : "",
        ]
          .filter(Boolean)
          .join(",");
        if (callFlags) lines.push(`flags=[${callFlags}]`);
      } else {
        lines.push(`call id=${c.id} accessHash=${c.accessHash} kind=discarded duration=${c.duration}`);
      }
      lines.push(
        `participants returned: ${r.participants.length}${r.participantsNextOffset ? ` (nextOffset=${r.participantsNextOffset})` : ""}`,
      );
      for (const p of r.participants.slice(0, 50)) {
        lines.push(renderGroupCallParticipant(p));
      }
      if (r.participants.length > 50) {
        lines.push(`  ... (${r.participants.length - 50} more)`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-group-call-participants",
    description:
      "List participants of the active group call (voice/video chat) attached to a chat with pagination (phone.GetGroupParticipants). Looks up the chat's current InputGroupCall automatically, then returns {count, participants[], nextOffset?, version}. Each participant includes peer, date, source, volume, muted/self/left/videoJoined flags, raise-hand rating, about text, and hasVideo/hasPresentation indicators. Cloud requires MCP_TELEGRAM_ENABLE_GROUP_CALLS=1 (set on this server).",
    inputSchema: {
      chat: z
        .string()
        .describe(
          "Group/supergroup/channel that currently has an active group call — id, @username, or display name fragment",
        ),
      ids: z
        .array(z.string())
        .max(100)
        .optional()
        .describe("Optional list of participant peer ids/@usernames to filter (max 100)"),
      sources: z
        .array(z.number().int())
        .max(100)
        .optional()
        .describe("Optional list of numeric source ids (audio SSRC) to filter participants"),
      offset: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response's nextOffset; omit for the first page"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max participants to return in this page (default 100)"),
    },
    annotations: READ_ONLY,
    requiresEnv: "MCP_TELEGRAM_ENABLE_GROUP_CALLS",
    handler: async ({ chat, ids, sources, offset, limit }, { telegram }) => {
      const r = await telegram.getGroupCallParticipants(chat, { ids, sources, offset, limit });
      const lines = [
        `count=${r.count} version=${r.version}${r.nextOffset ? ` nextOffset=${r.nextOffset}` : ""}`,
        `participants returned: ${r.participants.length}`,
      ];
      for (const p of r.participants.slice(0, 100)) {
        lines.push(renderGroupCallParticipant(p));
      }
      if (r.participants.length > 100) lines.push(`  ... (${r.participants.length - 100} more)`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  // ─── Destructive (Phase 2.1, gated by DestructiveGuard) ─────────────────
  {
    name: "telegram-clear-drafts",
    description:
      "Delete saved message drafts. Pass chatId to clear the draft for a single chat. Without chatId, clears drafts in ALL chats — requires confirmAllChats:true.",
    inputSchema: {
      chatId: z.string().optional().describe("Chat ID or username. If provided, clears draft only for this chat"),
      confirmAllChats: z
        .boolean()
        .optional()
        .describe("Must be true to wipe drafts across ALL chats when chatId is omitted"),
    },
    annotations: DESTRUCTIVE,
    preValidate: ({ chatId, confirmAllChats }) => {
      if (chatId !== undefined && confirmAllChats === true) {
        return errorResult("Pass either chatId or confirmAllChats=true, not both.");
      }
      if (chatId === undefined && confirmAllChats !== true) {
        return errorResult(
          "Refusing to clear drafts in ALL chats without explicit confirmation. " +
            "Pass chatId for a single chat, or confirmAllChats=true to wipe all drafts.",
        );
      }
      return null;
    },
    handler: async ({ chatId, confirmAllChats }, { telegram }) => {
      if (chatId !== undefined) {
        await telegram.saveDraft(chatId, "");
        return textResult(`Draft cleared for ${chatId}`);
      }
      if (confirmAllChats === true) {
        await telegram.clearAllDrafts();
        return textResult("Cleared drafts across all chats.");
      }
      // Defensive — preValidate already covers both branches.
      return errorResult("Unreachable");
    },
  },

  {
    name: "telegram-delete-fact-check",
    description: "Remove a fact-check annotation. Requires fact-checker privileges.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (channel)"),
      messageId: z.number().int().positive().describe("Message ID whose fact-check to remove"),
    },
    annotations: DESTRUCTIVE,
    handler: async ({ chatId, messageId }, { telegram }) => {
      await telegram.deleteFactCheck(chatId, messageId);
      return textResult(`Removed fact-check from message #${messageId} in ${chatId}`);
    },
  },
];
