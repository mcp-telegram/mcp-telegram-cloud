#!/usr/bin/env node
/**
 * Posts a GitHub release announcement to a Telegram chat via Bot API.
 *
 * Env:
 *   BOT_TOKEN        — @BotFather token for the release bot
 *   RELEASE_CHAT_ID  — numeric chat id (supergroup: -100...; channel: @username also works)
 *   RELEASE_TAG      — e.g. "v1.11.0"
 *   RELEASE_NAME     — release title (may be empty — falls back to tag)
 *   RELEASE_URL      — https://github.com/.../releases/tag/vX.Y.Z
 *   RELEASE_BODY     — markdown body from the GitHub release
 */

const TELEGRAM_LIMIT = 4096;

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function buildMessage(): string {
  const tag = req("RELEASE_TAG");
  const name = (process.env.RELEASE_NAME ?? "").trim() || tag;
  const url = req("RELEASE_URL");
  const rawBody = (process.env.RELEASE_BODY ?? "").trim();

  const header = `🚀 ${name}`;
  const link = url;

  const fixedChars = header.length + link.length + 4;
  const bodyBudget = TELEGRAM_LIMIT - fixedChars;
  const body = rawBody ? truncate(rawBody, bodyBudget) : "";

  return body ? `${header}\n\n${body}\n\n${link}` : `${header}\n\n${link}`;
}

async function main(): Promise<void> {
  const token = req("BOT_TOKEN");
  const chatId = req("RELEASE_CHAT_ID");
  const text = buildMessage();

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });

  const data = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
  if (!data.ok) {
    console.error("Telegram API error:", data.description ?? "unknown");
    process.exit(1);
  }
  console.log(`Posted release to chat ${chatId}, message_id=${data.result?.message_id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
