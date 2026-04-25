import { logger, logUser } from "../logger.js";
import type { BotClient } from "./api.js";
import type { Subscribers } from "./subscribers.js";

interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

const WELCOME_TEXT =
  "✅ Subscribed.\n\nYou'll get notifications about service status and breaking changes.\n\nSend /stop any time to unsubscribe.";

const GOODBYE_TEXT = "🛑 Unsubscribed. You won't receive further notifications. Send /start to resume.";

/**
 * Handle a single Telegram update. Returns nothing — webhooks expect 200 OK.
 *
 * Only private 1:1 chats are accepted; bot interactions in groups/channels are ignored
 * to avoid mass-subscribing every member of a group where the bot was added.
 */
export async function handleBotUpdate(
  update: TelegramUpdate,
  client: BotClient,
  subscribers: Subscribers,
): Promise<void> {
  const msg = update.message;
  if (!msg?.text || !msg.from) return;
  if (msg.chat.type !== "private") return;
  if (msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  // /start [param] — Telegram allows optional payload after the command (deep-links).
  if (text === "/start" || text.startsWith("/start ")) {
    // Capture deep-link payload (e.g. `subscribe`, `from-landing-faq`) — sanitised
    // to ASCII-printable, length-capped, so it can't smuggle anything weird into logs/DB.
    const rawPayload = text === "/start" ? "" : text.slice(7).trim();
    const payload = rawPayload.replace(/[^\x20-\x7E]/g, "").slice(0, 64);
    const source = payload ? `deeplink:${payload}` : "start";
    subscribers.subscribe(userId, source);
    logger.info("Bot subscribed", {
      component: "bot",
      event: "subscribe",
      userId: logUser(String(userId)),
      source,
    });
    await client.sendMessage(chatId, WELCOME_TEXT);
    return;
  }

  if (text === "/stop") {
    subscribers.unsubscribe(userId);
    logger.info("Bot unsubscribed", {
      component: "bot",
      event: "unsubscribe",
      userId: logUser(String(userId)),
    });
    await client.sendMessage(chatId, GOODBYE_TEXT);
    return;
  }

  // Unknown command — silent ignore; user is already subscribed if they ever did /start.
}
