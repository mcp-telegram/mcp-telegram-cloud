import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import {
  businessOnlyOnError,
  errorResult,
  premiumOnlyOnError,
  READ_ONLY,
  safeOpt,
  sanitize,
  textResult,
  WRITE,
} from "./helpers.js";

export const PROFILE_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-add-contact",
    description: "Add a user to your Telegram contacts. Use this to accept contact requests from non-contacts.",
    inputSchema: {
      userId: z.string().describe("User ID or username to add"),
      firstName: z.string().describe("First name for the contact"),
      lastName: z.string().optional().describe("Last name for the contact"),
      phone: z.string().optional().describe("Phone number for the contact"),
    },
    annotations: WRITE,
    handler: async ({ userId, firstName, lastName, phone }, { telegram }) => {
      const sanFirst = sanitize(firstName);
      const sanLast = safeOpt(lastName);
      await telegram.addContact(userId, sanFirst, sanLast, phone);
      return textResult(sanitize(`Contact added: ${sanFirst}${sanLast ? ` ${sanLast}` : ""} (${userId})`));
    },
  },

  {
    name: "telegram-set-emoji-status",
    description:
      "Set your profile emoji status (custom animated emoji shown next to your name). Requires Telegram Premium. Pass documentId or collectibleId to set — omit both to clear the status. Use telegram-list-emoji-statuses to browse available IDs.",
    inputSchema: {
      documentId: z
        .string()
        .optional()
        .describe("Custom emoji document ID (stringified long). Omit to clear the status."),
      collectibleId: z
        .string()
        .optional()
        .describe(
          "Collectible emoji ID (stringified long) — for paid unique emoji. Exactly one of documentId/collectibleId may be set.",
        ),
      untilUnix: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Unix timestamp when status expires. Omit for permanent."),
    },
    annotations: WRITE,
    preValidate: ({ documentId, collectibleId }) => {
      if (documentId && collectibleId) return errorResult("Only one of documentId or collectibleId may be set");
      return null;
    },
    handler: async ({ documentId, collectibleId, untilUnix }, { telegram }) => {
      await telegram.setEmojiStatus({ documentId, collectibleId, untilUnix });
      if (!documentId && !collectibleId) return textResult("Emoji status cleared");
      const id = collectibleId ?? documentId;
      const until = untilUnix ? ` until ${new Date(untilUnix * 1000).toISOString()}` : "";
      return textResult(sanitize(`Emoji status set: ${id}${until}`));
    },
    onError: premiumOnlyOnError("Setting an emoji status requires Telegram Premium."),
  },

  {
    name: "telegram-clear-recent-emoji-statuses",
    description: "Clear your recently-used emoji status list (the 'recent' section in the emoji status picker).",
    inputSchema: {},
    annotations: WRITE,
    handler: async (_args, { telegram }) => {
      await telegram.clearRecentEmojiStatuses();
      return textResult("Recent emoji statuses cleared");
    },
  },

  {
    name: "telegram-list-emoji-statuses",
    description:
      "List default or recently-used emoji statuses available for your account. Useful for finding a documentId to pass to a status-set tool.",
    inputSchema: {
      kind: z
        .enum(["default", "recent", "channel_default", "collectible"])
        .default("default")
        .describe(
          "Which list: default (popular set), recent (your recent usage), channel_default (for channels), collectible (paid unique)",
        ),
      limit: z.number().int().positive().max(200).default(50).describe("Max items to return"),
    },
    annotations: READ_ONLY,
    handler: async ({ kind, limit }, { telegram }) => {
      const items = await telegram.listEmojiStatuses(kind, limit);
      if (items.length === 0) return textResult(`[${kind}] (no statuses)`);
      const lines = items.map((s) => {
        const id = s.collectibleId ?? s.documentId ?? "empty";
        const until = s.until ? ` until=${s.until}` : " until=permanent";
        const title = s.title ? ` title="${s.title}"` : "";
        return `${s.kind} id=${id}${until}${title}`;
      });
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-set-profile-color",
    description:
      "Set your profile name color or profile background color. Requires Telegram Premium for colors above index 6 and for profile background patterns. Omit color to reset to default.",
    inputSchema: {
      forProfile: z
        .boolean()
        .default(false)
        .describe("true = profile page color + background pattern (Premium); false = name color in chat lists"),
      color: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("Color index (0-6 free palette; 7+ Premium custom). Omit to reset to default."),
      backgroundEmojiId: z
        .string()
        .optional()
        .describe(
          "Custom emoji document ID (stringified long) for profile background pattern (Premium). Omit to remove.",
        ),
    },
    annotations: WRITE,
    handler: async ({ forProfile, color, backgroundEmojiId }, { telegram }) => {
      await telegram.setProfileColor({ forProfile, color, backgroundEmojiId });
      if (color === undefined && !backgroundEmojiId) return textResult("Profile color reset");
      return textResult(
        `Profile color updated: forProfile=${forProfile} color=${color ?? "default"} bg=${backgroundEmojiId ?? "none"}`,
      );
    },
    onError: premiumOnlyOnError("Profile colors above index 6 and background patterns require Telegram Premium."),
  },

  {
    name: "telegram-set-birthday",
    description:
      "Set your birthday in your Telegram profile. Year is optional (omit to hide age). Pass clear=true to remove birthday. Requires day and month unless clearing.",
    inputSchema: {
      day: z.number().int().min(1).max(31).optional().describe("Day of month (1-31)"),
      month: z.number().int().min(1).max(12).optional().describe("Month (1-12)"),
      year: z.number().int().min(1900).max(2100).optional().describe("Year (optional — omit to hide age)"),
      clear: z.boolean().optional().describe("Pass true to remove birthday from profile"),
    },
    annotations: WRITE,
    preValidate: ({ clear, day, month }) => {
      if (!clear && (!day || !month)) return errorResult("day and month are required when not clearing");
      return null;
    },
    handler: async ({ day, month, year, clear }, { telegram }) => {
      await telegram.setBirthday({ day, month, year, clear });
      if (clear) return textResult("Birthday cleared");
      const yearStr = year ? `/${year}` : "";
      return textResult(`Birthday set: ${day}/${month}${yearStr}`);
    },
  },

  {
    name: "telegram-set-personal-channel",
    description:
      "Set the channel displayed on your profile as 'Personal Channel'. Pass clear=true to remove. Pass channelId or @username of a channel you own or are subscribed to.",
    inputSchema: {
      channelId: z.string().optional().describe("Channel ID or @username to feature on profile"),
      clear: z.boolean().optional().describe("Pass true to remove personal channel from profile"),
    },
    annotations: WRITE,
    preValidate: ({ channelId, clear }) => {
      if (!clear && !channelId) return errorResult("channelId is required when not clearing");
      if (clear && channelId) return errorResult("Cannot set channelId and clear=true simultaneously");
      return null;
    },
    handler: async ({ channelId, clear }, { telegram }) => {
      const title = await telegram.setPersonalChannel({ channelId, clear });
      if (clear) return textResult("Personal channel cleared");
      return textResult(sanitize(`Personal channel set to ${title ?? channelId}`));
    },
  },

  {
    name: "telegram-delete-profile-photo",
    description:
      "Delete one or more profile photos by their photo IDs. Use telegram-get-profile-photo to obtain the current photo ID. Returns which IDs were deleted and which were not found.",
    inputSchema: {
      photoIds: z
        .array(z.string().regex(/^\d{1,20}$/, "must be a numeric photo ID"))
        .min(1)
        .max(100)
        .describe("Array of photo IDs (stringified long) to delete from your profile photo history"),
    },
    annotations: WRITE,
    handler: async ({ photoIds }, { telegram }) => {
      const { deleted, missing } = await telegram.deleteProfilePhotos(photoIds);
      const parts = [`Deleted ${deleted.length} profile photo(s): ${deleted.join(", ")}`];
      if (missing.length) parts.push(`Not found: ${missing.join(", ")}`);
      return textResult(parts.join(". "));
    },
  },

  {
    name: "telegram-update-profile",
    description: "Update your Telegram profile — first name, last name, bio, or username",
    inputSchema: {
      firstName: z.string().optional().describe("New first name"),
      lastName: z.string().optional().describe("New last name"),
      bio: z.string().optional().describe("New bio/about text (max 70 chars, 300 for Premium)"),
      username: z.string().optional().describe("New username (without @)"),
    },
    annotations: WRITE,
    handler: async ({ firstName, lastName, bio, username }, { telegram }) => {
      const updates: string[] = [];
      const sanFirst = safeOpt(firstName);
      const sanLast = safeOpt(lastName);
      const sanBio = safeOpt(bio);
      if (sanFirst !== undefined || sanLast !== undefined || sanBio !== undefined) {
        await telegram.updateProfile({ firstName: sanFirst, lastName: sanLast, bio: sanBio });
        if (sanFirst !== undefined) updates.push(`firstName: ${sanFirst}`);
        if (sanLast !== undefined) updates.push(`lastName: ${sanLast}`);
        if (sanBio !== undefined) updates.push(`bio: ${sanBio}`);
      }
      if (username !== undefined) {
        const normalizedUsername = username.replace(/^@/, "");
        await telegram.updateUsername(normalizedUsername);
        updates.push(`username: @${normalizedUsername}`);
      }
      return textResult(sanitize(updates.length ? `Profile updated: ${updates.join(", ")}` : "No changes specified"));
    },
  },

  {
    name: "telegram-set-privacy",
    description:
      "Configure privacy settings for your Telegram account. Controls who can see your phone number, last seen, profile photo, etc.",
    inputSchema: {
      setting: z
        .enum(["phone_number", "last_seen", "profile_photo", "forwards", "calls", "groups", "bio"])
        .describe("Privacy setting to change"),
      rule: z.enum(["everyone", "contacts", "nobody"]).describe("Who can see/access this"),
      allowUsers: z.array(z.string()).optional().describe("User IDs/usernames to always allow (exceptions)"),
      disallowUsers: z.array(z.string()).optional().describe("User IDs/usernames to always disallow (exceptions)"),
    },
    annotations: WRITE,
    handler: async ({ setting, rule, allowUsers, disallowUsers }, { telegram }) => {
      await telegram.setPrivacy(setting, rule, allowUsers, disallowUsers);
      return textResult(`Privacy: ${setting} set to "${rule}"`);
    },
  },

  {
    name: "telegram-get-global-privacy-settings",
    description:
      "Get your account-level global privacy settings: whether new non-contacts are auto-archived/muted, whether archived chats are kept unmuted, whether read receipts are hidden, and whether non-contacts must have Premium to message you.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const s = await telegram.getGlobalPrivacySettings();
      const lines = [
        `archiveAndMuteNewNoncontactPeers: ${s.archiveAndMuteNewNoncontactPeers}`,
        `keepArchivedUnmuted: ${s.keepArchivedUnmuted}`,
        `keepArchivedFolders: ${s.keepArchivedFolders}`,
        `hideReadMarks: ${s.hideReadMarks}`,
        `newNoncontactPeersRequirePremium: ${s.newNoncontactPeersRequirePremium}`,
      ];
      return textResult(lines.join("\n"));
    },
  },

  {
    name: "telegram-set-global-privacy-settings",
    description:
      "Update account-level global privacy settings. Only pass the fields you want to change — omitted fields keep their current values. hideReadMarks and newNoncontactPeersRequirePremium require Telegram Premium.",
    inputSchema: {
      archiveAndMuteNewNoncontactPeers: z
        .boolean()
        .optional()
        .describe("Auto-archive and mute messages from unknown users"),
      keepArchivedUnmuted: z.boolean().optional().describe("Keep archived chats unmuted when archiving"),
      keepArchivedFolders: z.boolean().optional().describe("Keep archived chats in their folders"),
      hideReadMarks: z
        .boolean()
        .optional()
        .describe("Hide read receipts — others cannot see when you read their messages (Premium)"),
      newNoncontactPeersRequirePremium: z
        .boolean()
        .optional()
        .describe("Only allow users with Telegram Premium to message you if they are not in your contacts (Premium)"),
    },
    annotations: WRITE,
    handler: async (
      {
        archiveAndMuteNewNoncontactPeers,
        keepArchivedUnmuted,
        keepArchivedFolders,
        hideReadMarks,
        newNoncontactPeersRequirePremium,
      },
      { telegram },
    ) => {
      await telegram.setGlobalPrivacySettings({
        archiveAndMuteNewNoncontactPeers,
        keepArchivedUnmuted,
        keepArchivedFolders,
        hideReadMarks,
        newNoncontactPeersRequirePremium,
      });
      const changed = Object.entries({
        archiveAndMuteNewNoncontactPeers,
        keepArchivedUnmuted,
        keepArchivedFolders,
        hideReadMarks,
        newNoncontactPeersRequirePremium,
      })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return textResult(`Global privacy updated: ${changed || "no fields changed"}`);
    },
    onError: premiumOnlyOnError("hideReadMarks and newNoncontactPeersRequirePremium require Telegram Premium."),
  },

  {
    name: "telegram-toggle-paid-reaction-privacy",
    description: "Change leaderboard visibility of your paid reaction on a specific channel post (Layer 198 API).",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (channel)"),
      messageId: z.number().int().positive().describe("Message ID of the channel post"),
      private: z.boolean().describe("true = anonymous on leaderboard, false = show name"),
    },
    annotations: WRITE,
    handler: async ({ chatId, messageId, private: privateFlag }, { telegram }) => {
      await telegram.togglePaidReactionPrivacy(chatId, messageId, privateFlag);
      return textResult(
        `Updated paid reaction privacy on message #${messageId} in ${chatId}: ${privateFlag ? "anonymous" : "show name"}`,
      );
    },
  },

  {
    name: "telegram-set-default-reaction",
    description: "Set the default emoji reaction used in quick-reaction menus across Telegram",
    inputSchema: {
      emoji: z.string().min(1).max(8).describe("Emoji character (e.g. 👍 ❤️ 🔥)"),
    },
    annotations: WRITE,
    handler: async ({ emoji }, { telegram }) => {
      await telegram.setDefaultReaction(emoji);
      return textResult(sanitize(`Default reaction set to ${emoji}`));
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

  {
    name: "telegram-create-business-chat-link",
    description:
      "Create a Telegram Business chat link (t.me/m/<slug> deep-link that opens a chat with you pre-filled with a message). Returns JSON with link, slug, message, title, and views. Requires Telegram Business subscription.",
    inputSchema: {
      message: z.string().min(1).max(4096).describe("Pre-filled message text shown to users who click the link"),
      title: z.string().max(32).optional().describe("Admin-facing label (not visible to visitors, max 32 chars)"),
      parseMode: z.enum(["md", "html"]).optional().describe("Format message as Markdown or HTML"),
    },
    annotations: WRITE,
    handler: async ({ message, title, parseMode }, { telegram }) => {
      const r = await telegram.createBusinessChatLink({
        message: sanitize(message),
        title: safeOpt(title),
        parseMode,
      });
      const label = r.title ? ` "${r.title}"` : "";
      return textResult(sanitize(`Business chat link created: ${r.link}${label} (slug=${r.slug})`));
    },
    onError: businessOnlyOnError("Business chat links require a Telegram Business subscription."),
  },

  {
    name: "telegram-edit-business-chat-link",
    description:
      "Edit an existing Telegram Business chat link by its slug (the trailing segment after t.me/m/). Returns JSON with updated fields. Requires Telegram Business subscription.",
    inputSchema: {
      slug: z.string().min(1).describe("Link slug — the last path segment of t.me/m/<slug>"),
      message: z.string().min(1).max(4096).describe("New pre-filled message text"),
      title: z.string().max(32).optional().describe("New admin-facing label (max 32 chars)"),
      parseMode: z.enum(["md", "html"]).optional().describe("Format message as Markdown or HTML"),
    },
    annotations: WRITE,
    handler: async ({ slug, message, title, parseMode }, { telegram }) => {
      const r = await telegram.editBusinessChatLink({
        slug,
        message: sanitize(message),
        title: safeOpt(title),
        parseMode,
      });
      const label = r.title ? ` "${r.title}"` : "";
      return textResult(sanitize(`Business chat link updated: ${r.link}${label}`));
    },
    onError: businessOnlyOnError("Business chat links require a Telegram Business subscription."),
  },

  {
    name: "telegram-delete-business-chat-link",
    description: "Delete a Telegram Business chat link by its slug. Requires Telegram Business subscription.",
    inputSchema: {
      slug: z.string().min(1).describe("Link slug to delete (from t.me/m/<slug>)"),
    },
    annotations: WRITE,
    handler: async ({ slug }, { telegram }) => {
      await telegram.deleteBusinessChatLink(slug);
      return textResult(sanitize(`Business chat link '${slug}' deleted`));
    },
    onError: businessOnlyOnError("Business chat links require a Telegram Business subscription."),
  },

  {
    name: "telegram-set-business-hours",
    description:
      "Set Telegram Business work hours — days and time ranges when your business is open. Requires Telegram Business subscription. Pass clear=true to disable the work hours display entirely.",
    inputSchema: {
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone ID (e.g. 'Europe/Moscow', 'America/New_York'). Required when setting schedule."),
      openNow: z
        .boolean()
        .optional()
        .describe("Manually override current open/closed status. Omit to derive from schedule."),
      schedule: z
        .array(
          z.object({
            day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).describe("Day of week"),
            openFrom: z
              .string()
              .regex(/^\d{2}:\d{2}$/)
              .describe("Opening time in 24h HH:MM format"),
            openTo: z
              .string()
              .regex(/^\d{2}:\d{2}$/)
              .describe("Closing time in 24h HH:MM. Use '24:00' for end of day."),
          }),
        )
        .optional()
        .describe("Weekly schedule. Multiple ranges per day are allowed."),
      clear: z.boolean().optional().describe("Pass true to remove business hours entirely"),
    },
    annotations: WRITE,
    preValidate: ({ clear, timezone, schedule }) => {
      if (!clear && (!timezone || !schedule?.length)) {
        return errorResult("timezone and schedule are required when not clearing");
      }
      return null;
    },
    handler: async ({ timezone, openNow, schedule, clear }, { telegram }) => {
      await telegram.setBusinessWorkHours({ timezone, openNow, schedule, clear });
      if (clear) return textResult("Business hours cleared");
      return textResult(sanitize(`Business hours set: ${schedule?.length} range(s) in ${timezone}`));
    },
    onError: businessOnlyOnError("Business hours require a Telegram Business subscription."),
  },

  {
    name: "telegram-set-business-location",
    description:
      "Set Telegram Business physical location (address + optional geo coordinates). Requires Telegram Business subscription. Pass clear=true to remove.",
    inputSchema: {
      address: z.string().min(1).max(512).optional().describe("Street address text"),
      latitude: z.number().min(-90).max(90).optional().describe("Geo latitude (-90 to 90)"),
      longitude: z.number().min(-180).max(180).optional().describe("Geo longitude (-180 to 180)"),
      clear: z.boolean().optional().describe("Pass true to remove business location"),
    },
    annotations: WRITE,
    preValidate: ({ clear, address, latitude, longitude }) => {
      if (!clear && !address) return errorResult("address is required when not clearing");
      if ((latitude === undefined) !== (longitude === undefined)) {
        return errorResult("latitude and longitude must both be set or both omitted");
      }
      return null;
    },
    handler: async ({ address, latitude, longitude, clear }, { telegram }) => {
      await telegram.setBusinessLocation({
        address: safeOpt(address),
        latitude,
        longitude,
        clear,
      });
      if (clear) return textResult("Business location cleared");
      const geo = latitude !== undefined ? ` @ ${latitude},${longitude}` : "";
      return textResult(sanitize(`Business location set: ${address}${geo}`));
    },
    onError: businessOnlyOnError("Business location requires a Telegram Business subscription."),
  },

  {
    name: "telegram-set-business-greeting",
    description:
      "Set Telegram Business greeting message — auto-reply sent to new conversations using a quick reply shortcut as template. Requires Telegram Business subscription. Pass clear=true to disable.",
    inputSchema: {
      shortcutId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Quick reply shortcut ID (from telegram-get-quick-replies) used as the greeting template"),
      audience: z
        .enum(["all_new", "contacts_only", "non_contacts", "existing_only"])
        .default("all_new")
        .describe(
          "Who receives the greeting: all_new (new contacts+non-contacts), contacts_only, non_contacts, existing_only",
        ),
      includeUsers: z.array(z.string()).optional().describe("Additional usernames/IDs to always include"),
      excludeUsers: z
        .array(z.string())
        .optional()
        .describe("Usernames/IDs to exclude — overrides audience. Cannot be combined with includeUsers."),
      noActivityDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(7)
        .describe("Send greeting if user has been inactive for N days"),
      clear: z.boolean().optional().describe("Pass true to disable greeting message"),
    },
    annotations: WRITE,
    preValidate: ({ clear, shortcutId, includeUsers, excludeUsers }) => {
      if (!clear && shortcutId === undefined) return errorResult("shortcutId is required when not clearing");
      if (includeUsers?.length && excludeUsers?.length) {
        return errorResult("includeUsers and excludeUsers cannot both be set");
      }
      return null;
    },
    handler: async ({ shortcutId, audience, includeUsers, excludeUsers, noActivityDays, clear }, { telegram }) => {
      await telegram.setBusinessGreeting({
        shortcutId,
        audience,
        includeUsers,
        excludeUsers,
        noActivityDays,
        clear,
      });
      if (clear) return textResult("Business greeting cleared");
      return textResult(
        `Business greeting set: shortcut=${shortcutId} audience=${audience} noActivityDays=${noActivityDays}`,
      );
    },
    onError: businessOnlyOnError("Business greeting requires a Telegram Business subscription."),
  },

  {
    name: "telegram-set-business-away",
    description:
      "Set Telegram Business away message — auto-reply when you are offline or outside work hours. Uses a quick reply shortcut as template. Requires Telegram Business subscription. Pass clear=true to disable.",
    inputSchema: {
      shortcutId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Quick reply shortcut ID used as the away message template"),
      schedule: z
        .enum(["always", "outside_hours", "custom"])
        .default("outside_hours")
        .describe(
          "When to send: always (any time offline), outside_hours (based on business hours), custom (time range)",
        ),
      customFrom: z.number().int().positive().optional().describe("For schedule=custom: Unix timestamp range start"),
      customTo: z.number().int().positive().optional().describe("For schedule=custom: Unix timestamp range end"),
      offlineOnly: z
        .boolean()
        .default(true)
        .describe("Send only when you appear offline (true) or regardless of online status (false)"),
      audience: z
        .enum(["all_new", "contacts_only", "non_contacts", "existing_only"])
        .default("all_new")
        .describe("Who receives the away message"),
      includeUsers: z.array(z.string()).optional(),
      excludeUsers: z.array(z.string()).optional(),
      clear: z.boolean().optional().describe("Pass true to disable away message"),
    },
    annotations: WRITE,
    preValidate: ({ clear, shortcutId, schedule, customFrom, customTo, includeUsers, excludeUsers }) => {
      if (!clear && shortcutId === undefined) return errorResult("shortcutId is required when not clearing");
      if (schedule === "custom" && (customFrom === undefined || customTo === undefined)) {
        return errorResult("customFrom and customTo are required when schedule=custom");
      }
      if (includeUsers?.length && excludeUsers?.length) {
        return errorResult("includeUsers and excludeUsers cannot both be set");
      }
      return null;
    },
    handler: async (
      { shortcutId, schedule, customFrom, customTo, offlineOnly, audience, includeUsers, excludeUsers, clear },
      { telegram },
    ) => {
      await telegram.setBusinessAway({
        shortcutId,
        schedule,
        customFrom,
        customTo,
        offlineOnly,
        audience,
        includeUsers,
        excludeUsers,
        clear,
      });
      if (clear) return textResult("Business away message cleared");
      return textResult(`Business away message set: shortcut=${shortcutId} schedule=${schedule}`);
    },
    onError: businessOnlyOnError("Business away message requires a Telegram Business subscription."),
  },

  {
    name: "telegram-set-business-intro",
    description:
      "Set Telegram Business intro card — title and description shown to new users opening your chat, with an optional sticker. Requires Telegram Business subscription. Pass clear=true to remove.",
    inputSchema: {
      title: z.string().min(1).max(32).optional().describe("Intro title (max 32 chars)"),
      description: z.string().min(1).max(70).optional().describe("Intro description (max 70 chars)"),
      stickerId: z
        .string()
        .optional()
        .describe(
          "Sticker document ID (stringified long) — optional illustrative sticker. Requires stickerAccessHash and stickerFileReference.",
        ),
      stickerAccessHash: z
        .string()
        .optional()
        .describe("Access hash of the sticker document (required with stickerId)"),
      stickerFileReference: z
        .string()
        .regex(/^[\da-fA-F]{2,}$/)
        .refine((v) => v.length % 2 === 0, "must be even-length hex")
        .optional()
        .describe("Hex-encoded file_reference bytes (required with stickerId)"),
      clear: z.boolean().optional().describe("Pass true to remove the intro card"),
    },
    annotations: WRITE,
    preValidate: ({ clear, title, description, stickerId, stickerAccessHash, stickerFileReference }) => {
      if (!clear && (!title || !description)) {
        return errorResult("title and description are required when not clearing");
      }
      const stickerFields = [stickerId, stickerAccessHash, stickerFileReference].filter(Boolean);
      if (stickerFields.length > 0 && stickerFields.length < 3) {
        return errorResult("stickerId, stickerAccessHash, and stickerFileReference must all be set together");
      }
      return null;
    },
    handler: async (
      { title, description, stickerId, stickerAccessHash, stickerFileReference, clear },
      { telegram },
    ) => {
      await telegram.setBusinessIntro({
        title: safeOpt(title),
        description: safeOpt(description),
        stickerId,
        stickerAccessHash,
        stickerFileReference,
        clear,
      });
      if (clear) return textResult("Business intro cleared");
      return textResult(sanitize(`Business intro set: "${title}"`));
    },
    onError: businessOnlyOnError("Business intro requires a Telegram Business subscription."),
  },
];
