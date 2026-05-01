import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { errorResult, formatPeer, READ_ONLY, sanitize, textResult } from "./_helpers.js";

const STARS_ENV = "MCP_TELEGRAM_ENABLE_STARS";

export const STARS_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-get-stars-status",
    description:
      "Fetch the current Telegram Stars balance and recent activity for a peer (payments.GetStarsStatus). Pass 'me' / '@me' (or your own user id) to inspect your own wallet, or a bot/channel peer you own/administrate. Returns {balance:{amount,nanos}, subscriptions?[], subscriptionsNextOffset?, subscriptionsMissingBalance?, history?[], nextOffset?}. Each transaction has id, stars, date, peer (kind: appStore|playMarket|premiumBot|fragment|ads|api|peer|unsupported), and flags (refund/pending/failed/gift/reaction). Use telegram-get-stars-transactions for full paginated history. Cloud requires MCP_TELEGRAM_ENABLE_STARS=1 (set on this server). Read-only.",
    inputSchema: {
      peer: z
        .string()
        .min(1)
        .describe("Peer whose Stars wallet to inspect — 'me'/'@me' or user id for self, or a bot/channel you control"),
    },
    annotations: READ_ONLY,
    requiresEnv: STARS_ENV,
    handler: async ({ peer }, { telegram }) => {
      const r = await telegram.getStarsStatus(peer);
      return textResult(sanitize(JSON.stringify(r)));
    },
  },

  {
    name: "telegram-get-stars-transactions",
    description:
      "Fetch a paginated Telegram Stars transaction history for a peer (payments.GetStarsTransactions). Pass 'me'/'@me' (or your own user id) for your wallet, or a bot/channel peer you own/administrate. Filters: inbound (credits only), outbound (debits only), ascending (chronological; default descending), subscriptionId (scope to a single subscription). Paginate with offset (cursor string from a prior response's nextOffset) and limit (default 50). Returns {balance, history[], nextOffset?, subscriptions?[], ...} — same shape as telegram-get-stars-status but focused on transactions. Cloud requires MCP_TELEGRAM_ENABLE_STARS=1. Read-only.",
    inputSchema: {
      peer: z
        .string()
        .min(1)
        .describe("Peer whose Stars transactions to fetch — 'me'/'@me' or a bot/channel you control"),
      inbound: z.boolean().optional().describe("If true, return only inbound (credit) transactions"),
      outbound: z.boolean().optional().describe("If true, return only outbound (debit) transactions"),
      ascending: z
        .boolean()
        .optional()
        .describe("If true, return transactions chronologically (oldest first); default newest first"),
      subscriptionId: z.string().optional().describe("If set, restrict to a single subscription id"),
      offset: z
        .string()
        .optional()
        .describe("Pagination cursor — pass nextOffset from a previous response; omit for first page"),
      limit: z.number().int().min(1).max(100).optional().describe("Max transactions per page (default 50, max 100)"),
    },
    annotations: READ_ONLY,
    requiresEnv: STARS_ENV,
    preValidate: ({ inbound, outbound }) =>
      inbound && outbound ? errorResult("inbound and outbound are mutually exclusive — provide at most one") : null,
    handler: async ({ peer, inbound, outbound, ascending, subscriptionId, offset, limit }, { telegram }) => {
      const r = await telegram.getStarsTransactions(peer, {
        inbound,
        outbound,
        ascending,
        subscriptionId,
        offset,
        limit,
      });
      return textResult(sanitize(JSON.stringify(r)));
    },
  },

  {
    name: "telegram-get-stars-subscriptions",
    description:
      "List active Telegram Stars subscriptions for a peer (payments.GetStarsSubscriptions). Pass 'me' for your own account or a bot/channel you own. Returns subscription id, peer, untilDate, period, price in Stars, and canceled flag. Paginate with offset. Cloud requires MCP_TELEGRAM_ENABLE_STARS=1. Read-only.",
    inputSchema: {
      chatId: z.string().min(1).describe("Peer to query — 'me' for self, or a bot/channel you own"),
      offset: z.string().optional().describe("Pagination cursor from a prior nextOffset"),
      missingBalance: z.boolean().optional().describe("If true, return only subscriptions with missing balance"),
    },
    annotations: READ_ONLY,
    requiresEnv: STARS_ENV,
    handler: async ({ chatId, offset, missingBalance }, { telegram }) => {
      const r = await telegram.getStarsSubscriptions(chatId, { offset, missingBalance });
      const subs = r.subscriptions ?? [];
      if (subs.length === 0) return textResult("No active Stars subscriptions.");
      const lines = subs.map((s) => {
        const title = s.title ? ` "${s.title}"` : "";
        const status = s.canceled ? " [canceled]" : "";
        return `  [${s.id}] peer=${s.peerId} until=${s.untilDate} period=${s.periodSeconds}s price=${s.priceStars}⭐${title}${status}`;
      });
      if (r.nextOffset) lines.push(`nextOffset=${r.nextOffset}`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-stars-topup-options",
    description:
      "List available Telegram Stars top-up tiers (payments.GetStarsTopupOptions). Returns each tier with star count, currency, price amount (in smallest currency units), and whether it is an extended/premium tier. Cloud requires MCP_TELEGRAM_ENABLE_STARS=1. Read-only.",
    annotations: READ_ONLY,
    requiresEnv: STARS_ENV,
    handler: async (_args, { telegram }) => {
      const opts = await telegram.getStarsTopupOptions();
      if (opts.length === 0) return textResult("No Stars top-up tiers available.");
      const lines = opts.map((o) => `  ${o.stars}⭐ — ${o.amount} ${o.currency}${o.extended ? " [extended]" : ""}`);
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-available-star-gifts",
    description:
      "List all available Telegram Star Gifts that can be sent to other users. Returns gift id, cost in Stars, conversion value, availability (for limited gifts), and upgrade cost. Cloud requires MCP_TELEGRAM_ENABLE_STARS=1. Read-only.",
    annotations: READ_ONLY,
    requiresEnv: STARS_ENV,
    handler: async (_args, { telegram }) => {
      const gifts = await telegram.getAvailableStarGifts();
      if (gifts.length === 0) return textResult("No available Star Gifts.");
      const lines = gifts.map((g) => {
        const limited = g.limited ? ` [limited ${g.availabilityRemains ?? "?"}/${g.availabilityTotal ?? "?"}]` : "";
        const upgrade = g.upgradeStars ? ` upgrade=${g.upgradeStars}⭐` : "";
        return `  [${g.id}] ${g.stars}⭐ → convert=${g.convertStars}⭐${upgrade}${limited}`;
      });
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-saved-star-gifts",
    description:
      "List Star Gifts received by a user or chat. Pass 'me' for your own gifts. Supports pagination via offset/nextOffset and filtering flags (excludeUnsaved/Saved/Unlimited/Limited/Unique, sortByValue). Returns gift id, kind (regular|unique), title, cost in Stars, originating peer, msgId/savedId for use with telegram-save-star-gift, and upgrade eligibility. Cloud requires MCP_TELEGRAM_ENABLE_STARS=1. Read-only.",
    inputSchema: {
      chatId: z.string().min(1).describe("User or chat to fetch received gifts for — 'me' for self"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max gifts per page (default 20, max 100)"),
      offset: z.string().optional().describe("Pagination cursor from a prior nextOffset"),
      excludeUnsaved: z.boolean().optional().describe("Skip gifts the recipient chose to hide"),
      excludeSaved: z.boolean().optional().describe("Skip gifts the recipient chose to show"),
      excludeUnlimited: z.boolean().optional().describe("Skip unlimited-edition gifts"),
      excludeLimited: z.boolean().optional().describe("Skip limited-edition gifts"),
      excludeUnique: z.boolean().optional().describe("Skip unique gifts"),
      sortByValue: z.boolean().optional().describe("Sort by Star value descending instead of date"),
    },
    annotations: READ_ONLY,
    requiresEnv: STARS_ENV,
    handler: async (
      {
        chatId,
        limit,
        offset,
        excludeUnsaved,
        excludeSaved,
        excludeUnlimited,
        excludeLimited,
        excludeUnique,
        sortByValue,
      },
      { telegram },
    ) => {
      const r = await telegram.getSavedStarGifts(chatId, {
        limit,
        offset,
        excludeUnsaved,
        excludeSaved,
        excludeUnlimited,
        excludeLimited,
        excludeUnique,
        sortByValue,
      });
      const gifts = r.gifts ?? [];
      if (gifts.length === 0) return textResult(`No saved Star Gifts for ${chatId}.`);
      const lines: string[] = [`count=${r.count}`];
      for (const g of gifts) {
        const title = g.giftTitle ? ` "${g.giftTitle}"` : "";
        const stars = g.stars ? ` ${g.stars}⭐` : "";
        const convert = g.convertStars ? ` convert=${g.convertStars}⭐` : "";
        const upgrade = g.canUpgrade ? ` upgrade${g.upgradeStars ? `=${g.upgradeStars}⭐` : ""}` : "";
        const flags = g.unsaved ? " [hidden]" : "";
        const ref = g.msgId !== undefined ? `msgId=${g.msgId}` : `savedId=${g.savedId ?? "?"}`;
        const from = g.fromPeerId ? ` from ${formatPeer({ kind: "peer", id: g.fromPeerId })}` : "";
        lines.push(
          `  [${g.giftId}] ${g.giftKind}${title}${stars}${convert}${upgrade} ${ref}${from} date=${g.date}${flags}`,
        );
      }
      if (r.nextOffset) lines.push(`nextOffset=${r.nextOffset}`);
      return textResult(sanitize(lines.join("\n")));
    },
  },
];
