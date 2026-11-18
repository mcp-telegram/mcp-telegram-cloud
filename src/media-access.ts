import type { TelegramService } from "@overpod/mcp-telegram/service";
import { isTelegramAuthError } from "./auth-errors.js";
import { withDeadline } from "./deadline.js";
import type { Ticket } from "./download-store.js";
import { MediaError, unconfirmedRevocation } from "./media-errors.js";
import { confirmSessionRevoked } from "./session-confirm.js";
import type { SessionManager } from "./session-manager.js";

type Sessions = Pick<SessionManager, "listAccounts" | "getAccountAttachmentId" | "ensureAccountSession">;

/**
 * `canRead` for an account captured at the start of a tool call: true while the same
 * Telegram identity stays attached in the same slot. Detaching, re-adding or replacing
 * the account invalidates every ticket and upload made with it.
 */
export function accountBinding(
  sessions: Pick<SessionManager, "listAccounts" | "getAccountAttachmentId">,
  owner: string,
  accountId: number | undefined,
  attachmentId: string | undefined,
): { accountId: number; canRead: () => boolean } {
  if (accountId === undefined || !attachmentId) {
    throw new MediaError("ACCOUNT_UNAVAILABLE", "Source account was not bound to this tool call.");
  }
  const account = sessions.listAccounts(owner).find((a) => a.accountId === accountId);
  if (!account) throw new MediaError("ACCOUNT_UNAVAILABLE", "Source account is unavailable.");
  const canRead = () =>
    sessions.getAccountAttachmentId(owner, accountId) === attachmentId &&
    sessions
      .listAccounts(owner)
      .some(
        (a) =>
          a.accountId === accountId && a.telegramUserId === account.telegramUserId && a.addedAt === account.addedAt,
      );
  return { accountId, canRead };
}

/** Live client for the account a ticket or upload is bound to, with a connect deadline. */
export async function telegramForAccount(
  sessions: Sessions,
  owner: string,
  accountId: number,
  canRead: () => boolean,
  connectTimeoutMs: number,
): Promise<TelegramService> {
  if (!canRead()) {
    throw new MediaError("ACCOUNT_UNAVAILABLE", "The Telegram account this link was made for is no longer attached.");
  }
  let telegram: TelegramService;
  try {
    telegram = await withDeadline("connect:media", connectTimeoutMs * 2, () =>
      sessions.ensureAccountSession(owner, accountId),
    );
  } catch {
    throw new MediaError("ACCOUNT_UNAVAILABLE", "Could not connect to Telegram for this account. Retry shortly.", 5000);
  }
  if (!telegram.isConnected() || !canRead()) {
    throw new MediaError("ACCOUNT_UNAVAILABLE", "Could not connect to Telegram for this account. Retry shortly.", 5000);
  }
  return telegram;
}

/** Fails closed on a core without byte-range and streaming-upload support. */
export function requireMediaCore(telegram: TelegramService): void {
  const t = telegram as unknown as Record<string, unknown>;
  if (typeof t.openMedia !== "function" || typeof t.uploadStream !== "function") {
    throw new MediaError("SERVER_MISCONFIGURED", "This server runs a Telegram core without media streaming support.");
  }
}

/** Reader for a ticket's file, refusing to serve different bytes if the message's media changed. */
export async function openTicketMedia(telegram: TelegramService, ticket: Ticket) {
  requireMediaCore(telegram);
  const reader = await telegram.openMedia(ticket.metadata.chatId, ticket.metadata.messageId);
  // Same message, different file (edited media): never mix two files in one download.
  if (reader.info.fileId !== ticket.fileId || reader.info.size !== ticket.metadata.size) {
    throw new MediaError(
      "MEDIA_CHANGED",
      "The message's media changed after the download was prepared. Request the file again.",
    );
  }
  return reader;
}

/**
 * A media deadline means the account's connection may be wedged. Mark that exact client
 * like the registry does after a tool timeout, so the next call revalidates it instead of
 * reusing the stuck connection. No-op when the client is not known or no longer pooled.
 */
export function markWedged(
  sessions: { markUnhealthy?: SessionManager["markUnhealthy"] } | undefined,
  owner: string,
  client: TelegramService | undefined,
): void {
  if (client) sessions?.markUnhealthy?.(owner, { expected: client });
}

/**
 * Run `fn` against `client`, an account other than (or not known to be) the caller's own.
 * A Telegram revocation raised there, once confirmed on the main connection (see
 * {@link confirmSessionRevoked}), is reported for THAT client only (the session manager
 * acts on it only when it is the owner's pooled primary) and surfaces as a coded error
 * without the RPC error inside, so no caller can revoke a different, healthy session.
 */
export async function onAccount<T>(
  sessions: { reportDeadSession?: SessionManager["reportDeadSession"] } | undefined,
  owner: string,
  client: TelegramService,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isTelegramAuthError(e)) throw e;
    if (!(await confirmSessionRevoked(client))) throw unconfirmedRevocation();
    sessions?.reportDeadSession?.(owner, client);
    throw new MediaError(
      "ACCOUNT_UNAVAILABLE",
      "Telegram rejected the session of the account this file belongs to. Reconnect that account and try again.",
    );
  }
}
