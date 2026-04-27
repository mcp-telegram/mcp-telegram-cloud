import { logger } from "../logger.js";

const TELEGRAM_API = "https://api.telegram.org";
/** Telegram Bot API hard limit on sendMessage text. */
export const TELEGRAM_TEXT_LIMIT = 4096;

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Minimal Bot API wrapper — sendMessage + setWebhook. No 3rd-party deps. */
export class BotClient {
  constructor(private token: string) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<TgResponse<T>> {
    const res = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as TgResponse<T>;
  }

  /** Send plain text. Returns error_code on failure (403 = blocked, 400 = chat not found). */
  async sendMessage(
    chatId: number,
    text: string,
  ): Promise<{ ok: true } | { ok: false; errorCode: number; description: string }> {
    const data = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
    if (data.ok) return { ok: true };
    return { ok: false, errorCode: data.error_code ?? 0, description: data.description ?? "unknown" };
  }

  async setWebhook(url: string, secretToken?: string): Promise<TgResponse<unknown>> {
    return this.call("setWebhook", {
      url,
      ...(secretToken ? { secret_token: secretToken } : {}),
      // Only message updates — we don't care about edited messages, callback queries, etc.
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
  }

  async deleteWebhook(): Promise<TgResponse<unknown>> {
    return this.call("deleteWebhook", { drop_pending_updates: true });
  }

  async getMe(): Promise<TgResponse<{ id: number; username?: string }>> {
    return this.call("getMe", {});
  }
}

/** Truncate text to Telegram's 4096-char limit, preserving an ellipsis when cut. */
export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
}

type SendOutcome =
  | { kind: "sent" }
  | { kind: "blocked" } // 403 or chat-not-found / deactivated — should be unsubscribed
  | { kind: "ratelimit"; retryAfter: number }
  | { kind: "transient"; description: string };

function classify(
  result: { ok: true } | { ok: false; errorCode: number; description: string },
  retryAfterFromBody = 2,
): SendOutcome {
  if (result.ok) return { kind: "sent" };
  if (result.errorCode === 403 || /chat not found|user is deactivated/i.test(result.description)) {
    return { kind: "blocked" };
  }
  if (result.errorCode === 429) return { kind: "ratelimit", retryAfter: retryAfterFromBody };
  return { kind: "transient", description: result.description };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fan-out a message to many chat IDs with conservative pacing.
 *
 * Telegram's documented soft limit is 30 msgs/sec to different chats. We pace
 * at ~25/sec (40ms gap) to stay clear. On 429 we sleep then retry exactly
 * once; if the retry hits 403 / chat-not-found, the recipient is added to
 * `toUnsubscribe` just like first-shot blockers.
 */
export async function broadcastTo(
  client: BotClient,
  chatIds: number[],
  text: string,
): Promise<{ sent: number; failed: number; toUnsubscribe: number[] }> {
  const truncated = truncateForTelegram(text);
  const toUnsubscribe: number[] = [];
  let sent = 0;
  let failed = 0;

  for (const id of chatIds) {
    let outcome = classify(await client.sendMessage(id, truncated));

    if (outcome.kind === "ratelimit") {
      logger.warn("Broadcast hit rate limit, sleeping", {
        component: "bot",
        event: "broadcast.ratelimit",
        retryAfter: outcome.retryAfter,
      });
      await sleep(outcome.retryAfter * 1000);
      outcome = classify(await client.sendMessage(id, truncated));
    }

    switch (outcome.kind) {
      case "sent":
        sent += 1;
        break;
      case "blocked":
        toUnsubscribe.push(id);
        failed += 1;
        break;
      default:
        failed += 1;
    }

    await sleep(40);
  }

  return { sent, failed, toUnsubscribe };
}
