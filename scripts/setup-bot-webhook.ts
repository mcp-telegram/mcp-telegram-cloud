#!/usr/bin/env node
/**
 * One-shot configurator for the broadcast bot's webhook.
 *
 * Reads BOT_TOKEN, ISSUER and BOT_WEBHOOK_SECRET from env (.env or shell) and
 * tells Telegram to POST updates to `${ISSUER}/bot/webhook/${BOT_WEBHOOK_SECRET}`.
 *
 *   pnpm exec tsx scripts/setup-bot-webhook.ts          # set webhook
 *   pnpm exec tsx scripts/setup-bot-webhook.ts --info   # show current webhook
 *   pnpm exec tsx scripts/setup-bot-webhook.ts --delete # remove webhook
 *
 * dotenv is loaded best-effort: when run from CI the env is already populated
 * and dotenv may not be installed (no `node_modules`). Local runs still get .env.
 */
try {
  await import("dotenv/config");
} catch {
  // No dotenv available — fine, env is expected to be set by the caller.
}

function req(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

async function call(token: string, method: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main(): Promise<void> {
  const token = req("BOT_TOKEN");
  const arg = process.argv[2] ?? "";

  if (arg === "--info") {
    console.log(JSON.stringify(await call(token, "getWebhookInfo"), null, 2));
    return;
  }

  if (arg === "--delete") {
    const r = await call(token, "deleteWebhook", { drop_pending_updates: true });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const issuer = req("ISSUER").replace(/\/$/, "");
  const secret = req("BOT_WEBHOOK_SECRET");
  const url = `${issuer}/bot/webhook/${secret}`;

  const r = (await call(token, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  })) as { ok: boolean; description?: string };

  if (!r.ok) {
    console.error("setWebhook failed:", r.description);
    process.exit(1);
  }
  console.log(`Webhook set to ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
