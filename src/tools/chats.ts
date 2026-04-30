import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { premiumOnlyOnError, SAFE_WRITE, safeOpt, sanitize, textResult, WRITE } from "./_helpers.js";

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
];
