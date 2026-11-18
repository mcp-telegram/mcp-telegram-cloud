import type { TelegramService } from "@overpod/mcp-telegram/service";
import { isTelegramAuthError } from "./auth-errors.js";
import { config } from "./config.js";
import { withDeadline } from "./deadline.js";

/**
 * A call failed with a revocation-looking Telegram error. Requests that touch files go
 * through a connection to the file's data center that carries its own exported
 * authorization, and Telegram dropping THAT says nothing about the account. Only a cheap
 * call on the account's main connection that fails the same way confirms the session is
 * gone. Silence, timeouts and other errors are not confirmation: `getMe` has its own
 * deadline, and a hung one never revokes.
 */
export async function confirmSessionRevoked(client: TelegramService): Promise<boolean> {
  try {
    await withDeadline("confirm:session", config.telegramConnectTimeoutMs, () => client.getMe());
    return false;
  } catch (e) {
    return isTelegramAuthError(e);
  }
}

/** Text of a revocation-looking error that the main connection did not confirm. */
export const UNCONFIRMED_REVOCATION_MESSAGE =
  "Telegram reset the connection used for this request, but the account itself is still signed in. Retry.";
export const UNCONFIRMED_REVOCATION_RETRY_MS = 3000;
