import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { errorResult, premiumOnlyOnError, SAFE_WRITE, safeOpt, sanitize, textResult, WRITE } from "./_helpers.js";

export const CHATS_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-create-folder",
    description:
      "Create a new Telegram chat folder (filter). Returns the new folder ID. Pass type flags to auto-include entire categories, or list specific chats in includePeers. Emoticon must be a single emoji character.",
    inputSchema: {
      title: z.string().min(1).max(12).describe("Folder name (max 12 chars)"),
      emoticon: z.string().max(2).optional().describe("Single emoji icon for the folder"),
      contacts: z.boolean().optional().describe("Include all contacts"),
      nonContacts: z.boolean().optional().describe("Include all non-contacts"),
      groups: z.boolean().optional().describe("Include all groups"),
      broadcasts: z.boolean().optional().describe("Include all channels"),
      bots: z.boolean().optional().describe("Include all bots"),
      excludeMuted: z.boolean().optional().describe("Exclude muted chats"),
      excludeRead: z.boolean().optional().describe("Exclude read chats"),
      excludeArchived: z.boolean().optional().describe("Exclude archived chats"),
      includePeers: z
        .array(z.string())
        .max(100)
        .optional()
        .describe("Chat IDs/usernames to explicitly include (max 100)"),
      excludePeers: z
        .array(z.string())
        .max(100)
        .optional()
        .describe("Chat IDs/usernames to explicitly exclude (max 100)"),
      pinnedPeers: z.array(z.string()).max(5).optional().describe("Chats to pin at top of this folder (max 5)"),
    },
    annotations: WRITE,
    handler: async (
      {
        title,
        emoticon,
        contacts,
        nonContacts,
        groups,
        broadcasts,
        bots,
        excludeMuted,
        excludeRead,
        excludeArchived,
        includePeers,
        excludePeers,
        pinnedPeers,
      },
      { telegram },
    ) => {
      const id = await telegram.createFolder({
        title: sanitize(title),
        emoticon: safeOpt(emoticon),
        contacts,
        nonContacts,
        groups,
        broadcasts,
        bots,
        excludeMuted,
        excludeRead,
        excludeArchived,
        includePeers,
        excludePeers,
        pinnedPeers,
      });
      return textResult(`Folder created: "${sanitize(title)}" [id=${id}]`);
    },
  },

  {
    name: "telegram-edit-folder",
    description:
      "Edit an existing Telegram chat folder by its ID (from telegram-get-chat-folders). Only pass fields you want to change — omitted fields keep their current values.",
    inputSchema: {
      id: z.number().int().min(2).describe("Folder ID (≥ 2; 0 = All Chats, 1 = Archive are system folders)"),
      title: z.string().min(1).max(12).optional().describe("New folder name (max 12 chars)"),
      emoticon: z.string().max(2).optional().describe("New emoji icon"),
      contacts: z.boolean().optional(),
      nonContacts: z.boolean().optional(),
      groups: z.boolean().optional(),
      broadcasts: z.boolean().optional(),
      bots: z.boolean().optional(),
      excludeMuted: z.boolean().optional(),
      excludeRead: z.boolean().optional(),
      excludeArchived: z.boolean().optional(),
      includePeers: z.array(z.string()).max(100).optional().describe("Replace includePeers list entirely"),
      excludePeers: z.array(z.string()).max(100).optional().describe("Replace excludePeers list entirely"),
      pinnedPeers: z.array(z.string()).max(5).optional().describe("Replace pinnedPeers list entirely"),
    },
    annotations: WRITE,
    handler: async (
      {
        id,
        title,
        emoticon,
        contacts,
        nonContacts,
        groups,
        broadcasts,
        bots,
        excludeMuted,
        excludeRead,
        excludeArchived,
        includePeers,
        excludePeers,
        pinnedPeers,
      },
      { telegram },
    ) => {
      await telegram.editFolder(id, {
        title: safeOpt(title),
        emoticon: safeOpt(emoticon),
        contacts,
        nonContacts,
        groups,
        broadcasts,
        bots,
        excludeMuted,
        excludeRead,
        excludeArchived,
        includePeers,
        excludePeers,
        pinnedPeers,
      });
      return textResult(`Folder ${id} updated`);
    },
  },

  {
    name: "telegram-delete-folder",
    description:
      "Delete a Telegram chat folder by its ID. Chats inside the folder are not deleted — they remain in All Chats. System folders (0 = All Chats, 1 = Archive) cannot be deleted.",
    inputSchema: {
      id: z.number().int().min(2).describe("Folder ID to delete (≥ 2)"),
    },
    annotations: WRITE,
    handler: async ({ id }, { telegram }) => {
      await telegram.deleteFolder(id);
      return textResult(`Folder ${id} deleted`);
    },
  },

  {
    name: "telegram-reorder-folders",
    description:
      "Reorder Telegram chat folders by specifying a new order of folder IDs. All existing custom folder IDs must be included.",
    inputSchema: {
      order: z
        .array(z.number().int().min(2))
        .min(1)
        .describe("Ordered list of folder IDs (≥ 2). Obtain IDs from telegram-get-chat-folders"),
    },
    annotations: WRITE,
    handler: async ({ order }, { telegram }) => {
      await telegram.reorderFolders(order);
      return textResult(`Folders reordered: [${order.join(", ")}]`);
    },
  },

  {
    name: "telegram-toggle-folder-tags",
    description:
      "Enable or disable folder tags (colored labels that appear on messages in chat lists when the message belongs to a tagged folder). Requires Telegram Premium.",
    inputSchema: {
      enabled: z.boolean().describe("true to enable folder tags, false to disable"),
    },
    annotations: WRITE,
    handler: async ({ enabled }, { telegram }) => {
      await telegram.toggleDialogFilterTags(enabled);
      return textResult(`Folder tags ${enabled ? "enabled" : "disabled"}`);
    },
    onError: premiumOnlyOnError("Folder tags require Telegram Premium."),
  },

  {
    name: "telegram-kick-user",
    description: "Kick a user from a Telegram group (removes without permanent ban)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      userId: z.string().describe("User ID or username to kick"),
    },
    annotations: WRITE,
    handler: async ({ chatId, userId }, { telegram }) => {
      await telegram.kickUser(chatId, userId);
      return textResult(`Kicked ${userId} from ${chatId}`);
    },
  },

  {
    name: "telegram-ban-user",
    description: "Ban a user from a supergroup or channel (permanent until unbanned)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      userId: z.string().describe("User ID or username to ban"),
    },
    annotations: WRITE,
    handler: async ({ chatId, userId }, { telegram }) => {
      await telegram.banUser(chatId, userId);
      return textResult(`Banned ${userId} from ${chatId}`);
    },
  },

  {
    name: "telegram-unban-user",
    description: "Unban a previously banned user from a supergroup or channel",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      userId: z.string().describe("User ID or username to unban"),
    },
    annotations: WRITE,
    handler: async ({ chatId, userId }, { telegram }) => {
      await telegram.unbanUser(chatId, userId);
      return textResult(`Unbanned ${userId} in ${chatId}`);
    },
  },

  {
    name: "telegram-approve-join-request",
    description:
      "Approve or deny a pending join request for a supergroup or channel (basic groups are not supported). Admin with invite_users permission required.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username where the join request is pending"),
      userId: z.string().describe("User ID or username of the requesting user"),
      approved: z.boolean().describe("true to approve the join request, false to deny"),
    },
    annotations: WRITE,
    handler: async ({ chatId, userId, approved }, { telegram }) => {
      await telegram.approveChatJoinRequest(chatId, userId, approved);
      return textResult(`${approved ? "Approved" : "Denied"} join request from ${userId} in ${chatId}`);
    },
  },

  {
    name: "telegram-set-admin",
    description: "Promote a user to admin in a supergroup or channel with full permissions",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      userId: z.string().describe("User ID or username to promote"),
      title: z.string().optional().describe("Custom admin title"),
    },
    annotations: WRITE,
    handler: async ({ chatId, userId, title }, { telegram }) => {
      await telegram.setAdmin(chatId, userId, { title: safeOpt(title) });
      return textResult(`Promoted ${userId} to admin in ${chatId}${title ? ` (${title})` : ""}`);
    },
  },

  {
    name: "telegram-remove-admin",
    description: "Remove admin rights from a user in a supergroup or channel",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      userId: z.string().describe("User ID or username to demote"),
    },
    annotations: WRITE,
    handler: async ({ chatId, userId }, { telegram }) => {
      await telegram.removeAdmin(chatId, userId);
      return textResult(`Removed admin rights from ${userId} in ${chatId}`);
    },
  },

  {
    name: "telegram-archive-chat",
    description: "Archive or unarchive a Telegram dialog (moves to/from the Archive folder)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      archive: z.boolean().describe("true to archive, false to unarchive"),
    },
    annotations: WRITE,
    handler: async ({ chatId, archive }, { telegram }) => {
      await telegram.archiveChat(chatId, archive);
      return textResult(`${archive ? "Archived" : "Unarchived"} ${chatId}`);
    },
  },

  {
    name: "telegram-pin-chat",
    description: "Pin or unpin a Telegram dialog in the dialog list",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      pin: z.boolean().describe("true to pin, false to unpin"),
    },
    annotations: WRITE,
    handler: async ({ chatId, pin }, { telegram }) => {
      await telegram.pinDialog(chatId, pin);
      return textResult(`${pin ? "Pinned" : "Unpinned"} ${chatId}`);
    },
  },

  {
    name: "telegram-mark-dialog-unread",
    description: "Mark a Telegram dialog as unread (or clear the unread mark)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      unread: z.boolean().describe("true to mark as unread, false to clear the mark"),
    },
    annotations: SAFE_WRITE,
    handler: async ({ chatId, unread }, { telegram }) => {
      await telegram.markDialogUnread(chatId, unread);
      return textResult(`Marked ${chatId} as ${unread ? "unread" : "read"}`);
    },
  },

  {
    name: "telegram-set-slow-mode",
    description:
      "Set slow mode for a supergroup (minimum interval between messages per user). Allowed values: 0, 10, 30, 60, 300, 900, 3600 seconds (0 disables slow mode)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (supergroup)"),
      seconds: z
        .union([
          z.literal(0),
          z.literal(10),
          z.literal(30),
          z.literal(60),
          z.literal(300),
          z.literal(900),
          z.literal(3600),
        ])
        .describe("Interval in seconds: 0 (off), 10, 30, 60, 300, 900, or 3600"),
    },
    annotations: WRITE,
    handler: async ({ chatId, seconds }, { telegram }) => {
      await telegram.setSlowMode(chatId, seconds);
      return textResult(
        seconds === 0 ? `Disabled slow mode in ${chatId}` : `Set slow mode to ${seconds}s in ${chatId}`,
      );
    },
  },

  {
    name: "telegram-toggle-anti-spam",
    description:
      "Enable or disable aggressive anti-spam filtering in a supergroup. Supergroup only (not broadcast channels); requires admin with ban_users permission",
    inputSchema: {
      chatId: z.string().describe("Supergroup ID or username"),
      enabled: z.boolean().describe("true to enable aggressive anti-spam, false to disable"),
    },
    annotations: WRITE,
    handler: async ({ chatId, enabled }, { telegram }) => {
      await telegram.toggleAntiSpam(chatId, enabled);
      return textResult(`${enabled ? "Enabled" : "Disabled"} aggressive anti-spam in ${chatId}`);
    },
  },

  {
    name: "telegram-toggle-prehistory-hidden",
    description:
      "Toggle pre-history visibility for new members in a supergroup. When hidden=true, new joiners cannot see messages posted before they joined. Supergroup only; requires admin",
    inputSchema: {
      chatId: z.string().describe("Supergroup ID or username"),
      hidden: z.boolean().describe("true to hide prior history from new members, false to make it visible"),
    },
    annotations: WRITE,
    handler: async ({ chatId, hidden }, { telegram }) => {
      await telegram.togglePrehistoryHidden(chatId, hidden);
      return textResult(`${hidden ? "Hid" : "Revealed"} prehistory for new members in ${chatId}`);
    },
  },

  {
    name: "telegram-block-user",
    description: "Block a Telegram user. Blocked users cannot send you messages",
    inputSchema: { userId: z.string().describe("User ID or username to block") },
    annotations: WRITE,
    handler: async ({ userId }, { telegram }) => {
      await telegram.blockUser(userId);
      return textResult(`User blocked: ${userId}`);
    },
  },

  {
    name: "telegram-unblock-user",
    description: "Unblock a previously blocked Telegram user",
    inputSchema: { userId: z.string().describe("User ID or username to unblock") },
    annotations: WRITE,
    handler: async ({ userId }, { telegram }) => {
      await telegram.unblockUser(userId);
      return textResult(`User unblocked: ${userId}`);
    },
  },

  {
    name: "telegram-report-spam",
    description: "Report a chat as spam to Telegram",
    inputSchema: { chatId: z.string().describe("Chat ID or username to report") },
    annotations: WRITE,
    handler: async ({ chatId }, { telegram }) => {
      await telegram.reportSpam(chatId);
      return textResult(`Reported as spam: ${chatId}`);
    },
  },

  {
    name: "telegram-create-group",
    description:
      "Create a new Telegram group or supergroup. Set supergroup=true to enable >200 members and admin features; set forum=true (requires supergroup) to enable Topics.",
    inputSchema: {
      title: z.string().min(1).max(255).describe("Group name"),
      users: z
        .array(z.string())
        .min(1)
        .max(200)
        .describe("Usernames or IDs to invite (1-200). Telegram limits initial group membership to ~200"),
      supergroup: z.boolean().default(false).describe("Create as supergroup (supports >200 members, admin features)"),
      forum: z.boolean().default(false).describe("Enable topics (requires supergroup)"),
      description: z.string().max(255).optional().describe("Group description"),
    },
    annotations: WRITE,
    preValidate: ({ supergroup, forum }) =>
      forum && !supergroup ? errorResult("forum=true requires supergroup=true") : null,
    handler: async ({ title, users, supergroup, forum, description }, { telegram }) => {
      const result = await telegram.createGroup({
        title: sanitize(title),
        users,
        supergroup,
        forum,
        description: safeOpt(description),
      });
      const lines = [
        `Created ${result.type}: ${result.title}`,
        `ID: ${result.id}`,
        ...(result.inviteLink ? [`Invite link: ${result.inviteLink}`] : []),
      ];
      return textResult(lines.join("\n"));
    },
  },

  {
    name: "telegram-edit-group",
    description:
      "Edit a Telegram group's title or description. (Group photo updates are not exposed via the cloud since they require a server-side file path.)",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      title: z.string().min(1).max(255).optional().describe("New group title"),
      description: z.string().max(255).optional().describe("New group description (supergroups only)"),
    },
    annotations: WRITE,
    preValidate: ({ title, description }) =>
      title === undefined && description === undefined
        ? errorResult("Provide at least one of: title, description")
        : null,
    handler: async ({ chatId, title, description }, { telegram }) => {
      await telegram.editGroup(chatId, {
        title: safeOpt(title),
        description: safeOpt(description),
      });
      const changed = [title !== undefined && "title", description !== undefined && "description"].filter(Boolean);
      return textResult(`Updated ${changed.join(", ")} for ${chatId}`);
    },
  },

  {
    name: "telegram-invite-to-group",
    description: "Invite users to a Telegram group or channel. Returns lists of successfully invited and failed users.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      users: z.array(z.string()).min(1).max(50).describe("Usernames or IDs to invite (1-50 per call)"),
    },
    annotations: WRITE,
    handler: async ({ chatId, users }, { telegram }) => {
      const result = await telegram.inviteToGroup(chatId, users);
      const lines: string[] = [];
      if (result.invited.length > 0) lines.push(`Invited: ${result.invited.join(", ")}`);
      if (result.failed.length > 0) lines.push(`Failed: ${result.failed.join(", ")}`);
      return textResult(lines.length > 0 ? lines.join("\n") : `No users were invited to ${chatId}`);
    },
  },

  {
    name: "telegram-join-chat",
    description: "Join a Telegram group or channel by @username, t.me/group link, or t.me/+xxx invite link.",
    inputSchema: {
      target: z.string().min(1).describe("Username (@group), link (t.me/group), or invite link (t.me/+xxx)"),
    },
    annotations: WRITE,
    handler: async ({ target }, { telegram }) => {
      const result = await telegram.joinChat(target);
      return textResult(`Joined ${result.type}: ${sanitize(result.title)} (ID: ${result.id})`);
    },
  },

  {
    name: "telegram-leave-group",
    description: "Leave a Telegram group or channel.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
    },
    annotations: WRITE,
    handler: async ({ chatId }, { telegram }) => {
      await telegram.leaveGroup(chatId);
      return textResult(`Left chat ${chatId}`);
    },
  },

  {
    name: "telegram-create-invite-link",
    description:
      "Create a new invite link for a group or channel. Optional expireDate (Unix seconds), memberLimit, requestApproval (admin must approve joiners), and admin-only title.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      expireDate: z.number().int().positive().optional().describe("Link expiration as Unix timestamp"),
      memberLimit: z
        .number()
        .int()
        .min(1)
        .max(99999)
        .optional()
        .describe("Max number of users who can join via this link"),
      requestApproval: z.boolean().optional().describe("Require admin approval to join"),
      title: z.string().max(32).optional().describe("Label for the invite link (only visible to admins)"),
    },
    annotations: WRITE,
    handler: async ({ chatId, expireDate, memberLimit, requestApproval, title }, { telegram }) => {
      const link = await telegram.exportInviteLink(chatId, {
        expireDate,
        usageLimit: memberLimit,
        requestNeeded: requestApproval,
        title: safeOpt(title),
      });
      return textResult(`Invite link created: ${link}`);
    },
  },

  {
    name: "telegram-create-topic",
    description: "Create a new forum topic in a forum-enabled supergroup. Returns the new topic ID.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username of the forum supergroup"),
      title: z.string().min(1).max(128).describe("Topic title"),
      iconColor: z
        .union([
          z.literal(7322096),
          z.literal(16766590),
          z.literal(13338331),
          z.literal(9367192),
          z.literal(16749490),
          z.literal(16225862),
        ])
        .optional()
        .describe("Optional icon color (one of 7322096, 16766590, 13338331, 9367192, 16749490, 16225862)"),
      iconEmojiId: z
        .string()
        .regex(/^\d+$/, "iconEmojiId must be a numeric string")
        .optional()
        .describe("Optional custom emoji document ID for the icon (numeric string)"),
    },
    annotations: WRITE,
    handler: async ({ chatId, title, iconColor, iconEmojiId }, { telegram }) => {
      const safeTitle = sanitize(title);
      const topic = await telegram.createForumTopic(chatId, safeTitle, iconColor, iconEmojiId);
      return textResult(`Created topic "${sanitize(topic.title)}" (id=${topic.id}) in ${chatId}`);
    },
  },

  {
    name: "telegram-edit-topic",
    description: "Edit a forum topic — rename, change icon emoji, open/close, or show/hide the General topic.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username of the forum supergroup"),
      topicId: z.number().int().positive().describe("Topic ID (get from telegram-list-topics)"),
      title: z.string().min(1).max(128).optional().describe("New topic title"),
      iconEmojiId: z
        .string()
        .regex(/^\d+$/, "iconEmojiId must be a numeric string")
        .optional()
        .describe("New custom emoji document ID for the icon (numeric string)"),
      closed: z.boolean().optional().describe("Close (true) or reopen (false) the topic"),
      hidden: z.boolean().optional().describe("Hide (true) or show (false) the General topic"),
    },
    annotations: WRITE,
    preValidate: ({ title, iconEmojiId, closed, hidden }) =>
      title === undefined && iconEmojiId === undefined && closed === undefined && hidden === undefined
        ? errorResult("Provide at least one of: title, iconEmojiId, closed, hidden")
        : null,
    handler: async ({ chatId, topicId, title, iconEmojiId, closed, hidden }, { telegram }) => {
      await telegram.editForumTopic(chatId, topicId, {
        title: safeOpt(title),
        iconEmojiId,
        closed,
        hidden,
      });
      const changes: string[] = [];
      if (title !== undefined) changes.push(`title="${sanitize(title)}"`);
      if (iconEmojiId !== undefined) changes.push(`iconEmojiId=${iconEmojiId}`);
      if (closed !== undefined) changes.push(closed ? "closed" : "reopened");
      if (hidden !== undefined) changes.push(hidden ? "hidden" : "shown");
      return textResult(`Updated topic ${topicId} in ${chatId}: ${changes.join(", ")}`);
    },
  },

  {
    name: "telegram-toggle-channel-signatures",
    description:
      "Enable or disable author signatures on broadcast channel posts. Channel admin required; not supported for supergroups.",
    inputSchema: {
      chatId: z.string().describe("Channel ID or username"),
      enabled: z.boolean().describe("true to enable author signatures, false to disable"),
    },
    annotations: WRITE,
    handler: async ({ chatId, enabled }, { telegram }) => {
      await telegram.toggleChannelSignatures(chatId, enabled);
      return textResult(`${enabled ? "Enabled" : "Disabled"} author signatures in ${chatId}`);
    },
  },
];
