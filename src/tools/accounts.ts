import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { errorResult, READ_ONLY, textResult, WRITE } from "./_helpers.js";

/**
 * v2.32.0 multi-account tools.
 *
 * Concept: every OAuth-authenticated user has one PRIMARY Telegram account
 * (the one that completed the OAuth QR-login) plus zero or more SECONDARY
 * accounts attached via `accounts-add`. At any moment exactly one is ACTIVE —
 * that's the account used for every other `telegram-*` tool call. Switching
 * is a single SQLite row update — no reconnect, no token rotation, no new
 * OAuth flow. All 170+ existing tools work unchanged because `getTelegram()`
 * routes through `SessionManager.getSession`, which honours `active_account`.
 *
 * The five tools below cover: discover (`list`, `current`), switch, attach a
 * new account via short-lived URL (`add`), and detach (`remove`). The primary
 * cannot be removed here — only via OAuth revoke.
 */

const ADD_TOKEN_TTL_SECONDS = 600; // 10 min — enough to scan QR on a different device, short enough to be safe.

/** Format one account line as a short bullet. */
const fmt = (a: {
  accountId: number;
  telegramUserId: string;
  label: string | null;
  isPrimary: boolean;
  isActive: boolean;
}): string => {
  const tag = a.isActive ? "⭐ " : "   ";
  const id = a.isPrimary ? "primary" : String(a.accountId);
  const labelPart = a.label ? ` — ${a.label}` : "";
  const primaryNote = a.isPrimary ? " (primary, OAuth-bound)" : "";
  return `${tag}[${id}] @${a.telegramUserId}${labelPart}${primaryNote}`;
};

export const ACCOUNTS_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-accounts-list",
    description:
      "List all Telegram accounts attached to your connector — the primary OAuth-bound account plus any secondaries added via telegram-accounts-add. The active one (used for every other tool call) is marked with ⭐. Use telegram-accounts-switch to change it.",
    inputSchema: {},
    annotations: READ_ONLY,
    skipRequireConnection: true,
    handler: async (_args, { userId, sessions }) => {
      if (!userId || !sessions) return errorResult("Accounts tools require an authenticated MCP session.");
      const accounts = sessions.listAccounts(userId);
      if (accounts.length === 0) {
        return textResult(
          "No accounts attached yet. Reconnect your client (Disconnect → Connect) to set up the primary account.",
        );
      }
      const lines = [`${accounts.length} account(s):`, ...accounts.map(fmt)];
      lines.push("");
      lines.push("Switch with: telegram-accounts-switch identifier=<label|@username|account_id|primary>");
      lines.push("Add more with: telegram-accounts-add (returns a short-lived URL — scan QR on any device)");
      return textResult(lines.join("\n"));
    },
  },

  {
    name: "telegram-accounts-current",
    description:
      "Show which Telegram account is currently active — i.e. which account every other telegram-* tool is talking to. Cheap one-line check before sending a message.",
    inputSchema: {},
    annotations: READ_ONLY,
    skipRequireConnection: true,
    handler: async (_args, { userId, sessions }) => {
      if (!userId || !sessions) return errorResult("Accounts tools require an authenticated MCP session.");
      const accounts = sessions.listAccounts(userId);
      const active = accounts.find((a) => a.isActive);
      if (!active) {
        return textResult(
          "No active account. Reconnect your client (Disconnect → Connect) to set up the primary account.",
        );
      }
      const id = active.isPrimary ? "primary" : String(active.accountId);
      const labelPart = active.label ? ` — ${active.label}` : "";
      return textResult(`Active: [${id}] @${active.telegramUserId}${labelPart}`);
    },
  },

  {
    name: "telegram-accounts-switch",
    description:
      "Switch the active Telegram account. Pass an identifier — a custom label (e.g. 'testing'), Telegram username with or without @, the numeric account_id from telegram-accounts-list, or the literal 'primary'. The switch is instant: the next tool call will use the new account.",
    inputSchema: {
      identifier: z.string().describe("Label, @username, account_id, or 'primary'"),
    },
    annotations: WRITE,
    skipRequireConnection: true,
    handler: async ({ identifier }, { userId, sessions }) => {
      if (!userId || !sessions) return errorResult("Accounts tools require an authenticated MCP session.");
      const target = sessions.resolveAccount(userId, identifier);
      if (!target) {
        return errorResult(
          `No account matches "${identifier}". Run telegram-accounts-list to see all attached accounts.`,
        );
      }
      const accountId = target.isPrimary ? 0 : target.accountId;
      sessions.setActiveAccount(userId, accountId);
      // Materialise the new account's TelegramService eagerly so the next tool
      // call doesn't pay the connect cost itself.
      await sessions.ensureActiveSession(userId);
      const labelPart = target.label ? ` (${target.label})` : "";
      return textResult(`Switched to @${target.telegramUserId}${labelPart}. The next tool call will use this account.`);
    },
  },

  {
    name: "telegram-accounts-add",
    description:
      "Attach a NEW Telegram account to this connector. Returns a short-lived URL (10 min); open it on any device and scan the QR with the Telegram account you want to add. After login the account joins the list and you can switch to it. The primary account is unchanged — adding does NOT log it out.",
    inputSchema: {
      label: z
        .string()
        .max(64)
        .optional()
        .describe("Optional human label so you can switch by name later (e.g. 'testing', 'work')"),
    },
    annotations: WRITE,
    skipRequireConnection: true,
    handler: async ({ label }, { userId, sessions, baseUrl }) => {
      if (!userId || !sessions || !baseUrl) {
        return errorResult("Accounts tools require an authenticated MCP session.");
      }
      const normLabel = (label ?? "").trim() || null;
      const token = sessions.createAddAccountToken(userId, normLabel, ADD_TOKEN_TTL_SECONDS);
      const url = `${baseUrl}/accounts/add/${token}`;
      const lines = [
        `Open this URL on the device with the Telegram account you want to add:`,
        url,
        "",
        `Link expires in ${ADD_TOKEN_TTL_SECONDS / 60} minutes. Single-use.`,
      ];
      if (normLabel)
        lines.push(`Label: "${normLabel}" — switch later with: telegram-accounts-switch identifier=${normLabel}`);
      lines.push("After scanning the QR, run telegram-accounts-list to confirm the new account appears.");
      return textResult(lines.join("\n"));
    },
  },

  {
    name: "telegram-accounts-remove",
    description:
      "Detach a secondary Telegram account from this connector. The Telegram account itself is NOT logged out — only the binding here. You cannot remove the primary account this way; use the OAuth Disconnect flow in your client for that.",
    inputSchema: {
      identifier: z.string().describe("Label, @username, or account_id of the secondary to remove"),
    },
    annotations: WRITE,
    skipRequireConnection: true,
    handler: async ({ identifier }, { userId, sessions }) => {
      if (!userId || !sessions) return errorResult("Accounts tools require an authenticated MCP session.");
      const target = sessions.resolveAccount(userId, identifier);
      if (!target) {
        return errorResult(
          `No account matches "${identifier}". Run telegram-accounts-list to see all attached accounts.`,
        );
      }
      if (target.isPrimary) {
        return errorResult(
          "Cannot remove the primary account. Disconnect via your client's OAuth flow to fully sign out.",
        );
      }
      const removed = sessions.removeAccount(userId, target.accountId);
      if (!removed) return errorResult(`Account ${target.accountId} was already gone.`);
      return textResult(`Removed @${target.telegramUserId}. Active account fell back to primary if it was active.`);
    },
  },
];
