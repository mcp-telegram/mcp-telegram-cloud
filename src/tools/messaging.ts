import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { renderMessage, replyTargetFields, SAFE_WRITE, safeOpt, sanitize, textResult, WRITE } from "./_helpers.js";

export const MESSAGING_TOOLS: ToolDefinition[] = [
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
    name: "telegram-set-auto-delete",
    description:
      "Set auto-delete timer for messages in a chat. Common values: 86400 (1 day), 604800 (1 week), 2592000 (1 month). Use 0 to disable.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      period: z
        .number()
        .int()
        .nonnegative()
        .describe("Auto-delete period in seconds. 0 = disable. Common: 86400 (1d), 604800 (1w), 2592000 (1mo)"),
    },
    annotations: WRITE,
    handler: async ({ chatId, period }, { telegram }) => {
      await telegram.setAutoDelete(chatId, period);
      const status = period === 0 ? "disabled" : `set to ${period}s`;
      return textResult(`Auto-delete for ${chatId} ${status}`);
    },
  },

  {
    name: "telegram-send-reaction",
    description:
      "Send emoji reaction(s) to a message. Supports multiple reactions and adding to existing ones. Omit emoji to remove all reactions",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().describe("Message ID to react to"),
      emoji: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Reaction emoji(s): single '👍' or array ['👍','🔥']. Omit to remove all reactions"),
      addToExisting: z
        .boolean()
        .default(false)
        .describe("If true, add reaction(s) to existing ones instead of replacing"),
    },
    annotations: WRITE,
    handler: async ({ chatId, messageId, emoji, addToExisting }, { telegram }) => {
      const updated = await telegram.sendReaction(chatId, messageId, emoji, addToExisting);
      const emojiStr = Array.isArray(emoji) ? emoji.join("") : emoji;
      const action = emoji ? `Reacted ${emojiStr} to` : "Removed reactions from";
      const reactionsInfo = updated
        ? ` | Reactions: ${updated.map((r) => `${r.emoji}×${r.count}${r.me ? "(me)" : ""}`).join(" ")}`
        : "";
      return textResult(sanitize(`${action} message ${messageId} in ${chatId}${reactionsInfo}`));
    },
  },

  {
    name: "telegram-send-paid-reaction",
    description:
      "Send a paid reaction (★ Stars) on a channel post. Stars are spent from your balance. Optional private flag controls leaderboard visibility.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (channel)"),
      messageId: z.number().int().positive().describe("Message ID of the channel post"),
      count: z.number().int().min(1).max(2500).default(1).describe("Number of Stars to send (1-2500)"),
      private: z
        .boolean()
        .optional()
        .describe("true = anonymous on leaderboard, false = show name, omit = use account default"),
    },
    annotations: WRITE,
    handler: async ({ chatId, messageId, count, private: privateFlag }, { telegram }) => {
      await telegram.sendPaidReaction(chatId, messageId, count, { private: privateFlag });
      const privacy = privateFlag === true ? " (anonymous)" : privateFlag === false ? " (public)" : "";
      return textResult(`Sent ★×${count} paid reaction to message #${messageId} in ${chatId}${privacy}`);
    },
  },

  {
    name: "telegram-react-to-story",
    description: "React to a story with an emoji, or remove the current reaction by passing ''.",
    inputSchema: {
      chatId: z.string().describe("Peer who posted the story"),
      storyId: z.number().int().positive().describe("Story ID to react to"),
      emoji: z.string().max(8).describe("Reaction emoji. Empty string '' removes the reaction."),
      addToRecent: z.boolean().optional().describe("Add emoji to your recently used reactions"),
    },
    annotations: WRITE,
    handler: async ({ chatId, storyId, emoji, addToRecent }, { telegram }) => {
      await telegram.sendStoryReaction(chatId, storyId, emoji, addToRecent);
      return textResult(
        sanitize(emoji === "" ? `Removed reaction from story #${storyId}` : `Reacted ${emoji} to story #${storyId}`),
      );
    },
  },

  {
    name: "telegram-save-draft",
    description:
      "Save or clear a message draft for a chat. Pass empty text to clear the draft. Optional replyTo sets the message being replied to",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      text: z.string().describe("Draft text. Empty string clears the draft"),
      replyTo: z.number().int().positive().optional().describe("Message ID this draft replies to"),
    },
    annotations: WRITE,
    handler: async ({ chatId, text, replyTo }, { telegram }) => {
      await telegram.saveDraft(chatId, text, replyTo);
      return textResult(text === "" ? `Draft cleared for ${chatId}` : `Draft saved for ${chatId}`);
    },
  },

  {
    name: "telegram-vote-poll",
    description: "Vote in a poll by option index (single or multi-choice). Empty array retracts vote.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().int().positive().describe("Message ID of the poll"),
      optionIndexes: z
        .array(z.number().int().min(0).max(9))
        .min(0)
        .max(10)
        .describe("Zero-based option indexes. Empty [] retracts vote."),
    },
    annotations: WRITE,
    handler: async ({ chatId, messageId, optionIndexes }, { telegram }) => {
      const result = await telegram.sendPollVote(chatId, messageId, optionIndexes);
      if (optionIndexes.length === 0) {
        return textResult(`Retracted vote from poll #${messageId}`);
      }
      return textResult(
        sanitize(
          `Voted in poll #${messageId}: option(s) ${result.chosenLabels.join(", ")} | Total: ${result.totalVoters} voters`,
        ),
      );
    },
  },

  {
    name: "telegram-rate-transcription",
    description: "Rate transcription quality (good/poor) to improve Telegram speech-to-text.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().int().positive().describe("Message ID of the voice or video note"),
      transcriptionId: z.string().describe("Transcription ID returned by telegram-transcribe-audio"),
      good: z.boolean().describe("true = good quality, false = poor quality"),
    },
    annotations: WRITE,
    handler: async ({ chatId, messageId, transcriptionId, good }, { telegram }) => {
      await telegram.rateTranscription(chatId, messageId, transcriptionId, good);
      return textResult(
        `Rated transcription ${transcriptionId} for message #${messageId} as ${good ? "good" : "poor"}`,
      );
    },
  },

  {
    name: "telegram-send-message",
    description: "Send a message to a Telegram chat",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (e.g. @username or numeric ID)"),
      text: z.string().describe("Message text"),
      replyTo: z.number().optional().describe("Message ID to reply to"),
      parseMode: z.enum(["md", "html"]).optional().describe("Message format: md (Markdown) or html"),
      topicId: z.number().optional().describe("Forum topic ID to send message into (for groups with Topics enabled)"),
      quoteText: z
        .string()
        .optional()
        .describe(
          "Optional excerpt from the replied-to message to show as a quote above your reply. " +
            "Requires `replyTo` to be set. Must be a verbatim substring of the original message text.",
        ),
      effect: z
        .string()
        .regex(/^\d{1,19}$/)
        .optional()
        .describe(
          "Optional message effect ID (numeric string, up to 19 digits). Premium animated effect attached to the message.",
        ),
    },
    annotations: WRITE,
    handler: async ({ chatId, text, replyTo, parseMode, topicId, quoteText, effect }, { telegram }) => {
      const extra = quoteText || effect ? { quoteText: safeOpt(quoteText), effect } : undefined;
      const result = await telegram.sendMessage(chatId, sanitize(text), replyTo, parseMode, topicId, extra);
      const dest = topicId ? `topic ${topicId} in ${chatId}` : chatId;
      const idInfo = result?.id ? ` [#${result.id}]` : "";
      return textResult(`Message sent to ${dest}${idInfo}`);
    },
  },

  {
    name: "telegram-edit-message",
    description: "Edit a previously sent message in Telegram",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageId: z.number().describe("ID of the message to edit"),
      text: z.string().describe("New message text"),
    },
    annotations: WRITE,
    handler: async ({ chatId, messageId, text }, { telegram }) => {
      await telegram.editMessage(chatId, messageId, sanitize(text));
      return textResult(`Message ${messageId} edited in ${chatId}`);
    },
  },

  {
    name: "telegram-forward-message",
    description: "Forward messages between Telegram chats",
    inputSchema: {
      fromChatId: z.string().describe("Source chat ID or username"),
      toChatId: z.string().describe("Destination chat ID or username"),
      messageIds: z.array(z.number()).describe("Array of message IDs to forward"),
    },
    annotations: WRITE,
    handler: async ({ fromChatId, toChatId, messageIds }, { telegram }) => {
      await telegram.forwardMessage(fromChatId, toChatId, messageIds);
      return textResult(`Forwarded ${messageIds.length} message(s) from ${fromChatId} to ${toChatId}`);
    },
  },

  {
    name: "telegram-send-typing",
    description: "Send a typing/upload indicator to a Telegram chat (or cancel it)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      action: z
        .enum(["typing", "upload_photo", "upload_document", "cancel"])
        .default("typing")
        .describe("Typing action to broadcast"),
    },
    annotations: WRITE,
    handler: async ({ chatId, action }, { telegram }) => {
      await telegram.sendTyping(chatId, action);
      return textResult(`Typing indicator (${action}) sent to ${chatId}`);
    },
  },

  {
    name: "telegram-send-location",
    description:
      "Send a geographic location to a Telegram chat. Static pin by default; set livePeriod to share a live-updating location for N seconds.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees (-90 to 90)"),
      longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees (-180 to 180)"),
      accuracyRadius: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Horizontal accuracy radius in meters (0 = unknown)"),
      livePeriod: z
        .number()
        .int()
        .min(60)
        .max(86400)
        .optional()
        .describe("If set, sends a live location updated for N seconds (60-86400). Omit for static pin."),
      heading: z
        .number()
        .int()
        .min(1)
        .max(360)
        .optional()
        .describe("Direction the user is heading, 1-360 degrees (meaningful only for live locations)"),
      proximityRadius: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Alert radius for proximity notification in meters (live only)"),
      replyTo: z.number().int().positive().optional().describe("Message ID to reply to"),
      topicId: z.number().int().positive().optional().describe("Forum topic ID"),
    },
    annotations: WRITE,
    handler: async (
      { chatId, latitude, longitude, accuracyRadius, livePeriod, heading, proximityRadius, replyTo, topicId },
      { telegram },
    ) => {
      const { id } = await telegram.sendLocation(chatId, latitude, longitude, {
        accuracyRadius,
        livePeriod,
        heading,
        proximityRadius,
        replyTo,
        topicId,
      });
      const label = livePeriod ? `Live location sent to ${chatId} for ${livePeriod}s` : `Location sent to ${chatId}`;
      return textResult(`${label} [#${id}]`);
    },
  },

  {
    name: "telegram-send-venue",
    description: "Send a venue card (point-of-interest with title and address) to a Telegram chat.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      latitude: z.number().min(-90).max(90).describe("Venue latitude"),
      longitude: z.number().min(-180).max(180).describe("Venue longitude"),
      title: z.string().min(1).max(256).describe("Venue name (e.g. 'Red Square')"),
      address: z.string().min(1).max(512).describe("Street address"),
      provider: z
        .string()
        .max(32)
        .optional()
        .describe("Data provider — typically 'foursquare' or 'gplaces'. Defaults to 'foursquare'."),
      venueId: z.string().max(256).optional().describe("Provider-specific venue ID"),
      venueType: z.string().max(256).optional().describe("Provider-specific venue type category"),
      ...replyTargetFields,
    },
    annotations: WRITE,
    handler: async (
      { chatId, latitude, longitude, title, address, provider, venueId, venueType, replyTo, topicId },
      { telegram },
    ) => {
      const safeTitle = sanitize(title);
      const { id } = await telegram.sendVenue(chatId, latitude, longitude, safeTitle, sanitize(address), {
        provider: safeOpt(provider),
        venueId: safeOpt(venueId),
        venueType: safeOpt(venueType),
        replyTo,
        topicId,
      });
      return textResult(`Venue "${safeTitle}" sent to ${chatId} [#${id}]`);
    },
  },

  {
    name: "telegram-send-contact",
    description: "Send a contact card (phone number + name) to a Telegram chat.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      phone: z
        .string()
        .regex(/^\+?\d{6,15}$/)
        .describe(
          "Phone number in E.164-like format — 6-15 digits, optional leading +. " +
            "Note: sent as-is; Telegram shows the number to the recipient.",
        ),
      firstName: z.string().min(1).max(64).describe("Contact first name"),
      lastName: z.string().max(64).optional().describe("Contact last name"),
      vcard: z.string().max(2048).optional().describe("Optional vCard v3.0 text content"),
      ...replyTargetFields,
    },
    annotations: WRITE,
    handler: async ({ chatId, phone, firstName, lastName, vcard, replyTo, topicId }, { telegram }) => {
      const safeFirstName = sanitize(firstName);
      const { id } = await telegram.sendContact(chatId, phone, safeFirstName, {
        lastName: safeOpt(lastName),
        vcard: safeOpt(vcard),
        replyTo,
        topicId,
      });
      return textResult(`Contact ${safeFirstName} sent to ${chatId} [#${id}]`);
    },
  },

  {
    name: "telegram-send-dice",
    description:
      "Send an animated dice/game emoji to a Telegram chat. Returns the server-rolled value — useful for games, " +
      "coin-flips, random picks. Values: 🎲🎯🎳 = 1-6, 🏀⚽ = 1-5, 🎰 = slot combo 1-64.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      emoji: z
        .enum(["🎲", "🎯", "🎰", "🏀", "⚽", "🎳"])
        .default("🎲")
        .describe(
          "Dice emoji: 🎲 dice (1-6), 🎯 dart (1-6), 🎰 slot machine (1-64), 🏀 basketball (1-5), ⚽ football (1-5), 🎳 bowling (1-6)",
        ),
      ...replyTargetFields,
    },
    annotations: WRITE,
    handler: async ({ chatId, emoji, replyTo, topicId }, { telegram }) => {
      const { id, value } = await telegram.sendDice(chatId, emoji, { replyTo, topicId });
      const rolled = value !== undefined ? `: rolled ${value}` : " (value pending)";
      return textResult(`Dice ${emoji} sent to ${chatId}${rolled} [#${id}]`);
    },
  },

  {
    name: "telegram-translate-message",
    description:
      "Translate one or more Telegram messages to a target language (requires Telegram Premium). Consumes account translation quota.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      messageIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(100)
        .describe("Array of message IDs to translate (1-100)"),
      toLang: z
        .string()
        .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
        .describe("ISO 639-1 (e.g. 'en', 'ru') or locale (e.g. 'en-US')"),
    },
    annotations: WRITE,
    handler: async ({ chatId, messageIds, toLang }, { telegram }) => {
      const translations = await telegram.translateText(chatId, messageIds, toLang);
      const text =
        translations.length === messageIds.length
          ? translations.map((t, i) => `[#${messageIds[i]}] ${t}`).join("\n\n")
          : translations.join("\n\n");
      return textResult(sanitize(text) || "No translations");
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (/PREMIUM|PAYMENT_REQUIRED|TRANSLATE_REQ/i.test(msg)) {
        return {
          content: [{ type: "text", text: "Message translation requires Telegram Premium on this account" }],
          isError: true,
        };
      }
      return null;
    },
  },

  {
    name: "telegram-get-unread-mentions",
    description:
      "Get unread @mentions addressed to you in a Telegram chat. Marks all mentions as read on the server when all unread mentions fit within the requested limit.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      limit: z.number().default(20).describe("Maximum number of mentions to return"),
    },
    annotations: WRITE,
    handler: async ({ chatId, limit }, { telegram }) => {
      const messages = await telegram.getUnreadMentions(chatId, limit);
      const text = messages.map(renderMessage).join("\n\n");
      return textResult(sanitize(text) || "No unread mentions");
    },
  },

  {
    name: "telegram-get-unread-reactions",
    description:
      "Get messages with unread reactions on your posts in a Telegram chat. Marks all reactions as read on the server when all unread reactions fit within the requested limit.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      limit: z.number().default(20).describe("Maximum number of messages to return"),
    },
    annotations: WRITE,
    handler: async ({ chatId, limit }, { telegram }) => {
      const messages = await telegram.getUnreadReactions(chatId, limit);
      const text = messages.map(renderMessage).join("\n\n");
      return textResult(sanitize(text) || "No messages with unread reactions");
    },
  },
];
