import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { formatPeer, READ_ONLY, sanitize, textResult } from "./_helpers.js";

export const STATS_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-get-admin-log",
    description:
      "Get the admin action log (recent event history) of a supergroup or channel. Includes bans, edits, pins, and role changes.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (supergroup or channel)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Number of events to return (1-100)"),
      q: z.string().optional().describe("Optional text filter for events"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, limit, q }, { telegram }) => {
      const events = await telegram.getAdminLog(chatId, limit, q);
      if (events.length === 0) return textResult("No admin log events.");
      const text = events.map((e) => `[${e.date}] ${e.userName} (${e.userId}) — ${e.action}: ${e.details}`).join("\n");
      return textResult(sanitize(text));
    },
  },

  {
    name: "telegram-get-broadcast-stats",
    description:
      "Get broadcast channel statistics: followers, views/shares/reactions per post & story, notification percent, recent post interactions. Broadcast channels only (use telegram-get-megagroup-stats for supergroups). Admin rights required; some channels may require Telegram Premium to expose stats.",
    inputSchema: {
      chatId: z.string().describe("Broadcast channel ID or username"),
      includeGraphs: z
        .boolean()
        .default(false)
        .describe("Include raw graph data for each series. Default false — returns only aggregate numbers + metadata"),
      dark: z.boolean().default(false).describe("Prefer dark-theme palette when Telegram renders graphs"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, includeGraphs, dark }, { telegram }) => {
      const s = await telegram.getBroadcastStats(chatId, { dark, includeGraphs });
      const lines = [
        `Period: ${new Date(s.period.minDate * 1000).toISOString()} → ${new Date(s.period.maxDate * 1000).toISOString()}`,
        `Followers: ${s.followers.current} (Δ ${s.followers.current - s.followers.previous})`,
        `Views/post: ${s.viewsPerPost.current}, Shares/post: ${s.sharesPerPost.current}, Reactions/post: ${s.reactionsPerPost.current}`,
        `Views/story: ${s.viewsPerStory.current}, Shares/story: ${s.sharesPerStory.current}, Reactions/story: ${s.reactionsPerStory.current}`,
        `Notifications enabled: ${s.enabledNotifications.percent}% (${s.enabledNotifications.part}/${s.enabledNotifications.total})`,
      ];
      if (s.recentPostsInteractions.length > 0) {
        lines.push(`\nRecent interactions (${s.recentPostsInteractions.length}):`);
        for (const r of s.recentPostsInteractions.slice(0, 10)) {
          const id = r.kind === "message" ? `msg #${r.msgId}` : `story #${r.storyId}`;
          lines.push(`  ${id}: ${r.views} views, ${r.forwards} forwards, ${r.reactions} reactions`);
        }
      }
      if (includeGraphs && s.graphs) {
        lines.push(`\nGraphs available: ${Object.keys(s.graphs).join(", ")}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-megagroup-stats",
    description:
      "Get supergroup statistics: members, messages, viewers, posters (current vs previous period), top posters/admins/inviters. Supergroups only (use telegram-get-broadcast-stats for broadcast channels). Admin rights required. Telegram rate-limits this endpoint to roughly 1 request per 30 minutes per channel — expect FLOOD_WAIT on rapid repeat calls.",
    inputSchema: {
      chatId: z.string().describe("Supergroup ID or username"),
      includeGraphs: z
        .boolean()
        .default(false)
        .describe("Include raw graph data. Default false — returns only aggregate numbers + top lists"),
      dark: z.boolean().default(false).describe("Prefer dark-theme palette when Telegram renders graphs"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, includeGraphs, dark }, { telegram }) => {
      const s = await telegram.getMegagroupStats(chatId, { dark, includeGraphs });
      const lines = [
        `Period: ${new Date(s.period.minDate * 1000).toISOString()} → ${new Date(s.period.maxDate * 1000).toISOString()}`,
        `Members: ${s.members.current}, Messages: ${s.messages.current}, Viewers: ${s.viewers.current}, Posters: ${s.posters.current}`,
      ];
      if (s.topPosters.length > 0) {
        lines.push(`\nTop posters (${s.topPosters.length}):`);
        for (const p of s.topPosters.slice(0, 10))
          lines.push(`  ${p.userId}: ${p.messages} msgs, ${p.avgChars} avg chars`);
      }
      if (s.topAdmins.length > 0) {
        lines.push(`\nTop admins (${s.topAdmins.length}):`);
        for (const a of s.topAdmins.slice(0, 10))
          lines.push(`  ${a.userId}: ${a.deleted} del, ${a.kicked} kick, ${a.banned} ban`);
      }
      if (s.topInviters.length > 0) {
        lines.push(`\nTop inviters (${s.topInviters.length}):`);
        for (const i of s.topInviters.slice(0, 10)) lines.push(`  ${i.userId}: ${i.invitations} invites`);
      }
      if (includeGraphs && s.graphs) {
        lines.push(`\nGraphs available: ${Object.keys(s.graphs).join(", ")}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-my-boosts",
    description:
      "List the user's premium boost slots. Each entry includes slot index, the peer it currently boosts (if any), the date the boost was applied, expiration timestamp, and cooldownUntilDate (when a slot can be reassigned). Premium users have multiple slots; non-Premium users typically have a single slot.",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const r = await telegram.getMyBoosts();
      if (r.count === 0) return textResult("No boost slots.");
      const lines = [`${r.count} boost slot(s):`];
      for (const b of r.myBoosts) {
        const cd = b.cooldownUntilDate ? `, cooldown until ${b.cooldownUntilDate}` : "";
        lines.push(
          `  slot ${b.slot}: ${formatPeer(b.peer, "(unassigned)")} since ${b.date}, expires ${b.expires}${cd}`,
        );
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-boosts-status",
    description:
      "Fetch the boost status of a channel/supergroup. Returns current boost level, total boosts, progress to next level, giftBoosts, premiumAudience ratio, public boostUrl, and whether the current user is boosting (myBoost + myBoostSlots). Also includes any prepaidGiveaways attached to the chat.",
    inputSchema: {
      chatId: z.string().describe("Channel or supergroup to query — id or @username"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId }, { telegram }) => {
      const s = await telegram.getBoostsStatus(chatId);
      const lines = [
        `Level: ${s.level} (${s.boosts} boosts)`,
        `Progress: ${s.currentLevelBoosts}${s.nextLevelBoosts != null ? ` / ${s.nextLevelBoosts}` : ""}`,
        `Boost URL: ${s.boostUrl}`,
      ];
      if (s.giftBoosts != null) lines.push(`Gift boosts: ${s.giftBoosts}`);
      if (s.premiumAudience) {
        lines.push(`Premium audience: ${s.premiumAudience.part}/${s.premiumAudience.total}`);
      }
      if (s.myBoost) lines.push(`I'm boosting (slots: ${s.myBoostSlots?.join(", ") ?? "?"})`);
      if (s.prepaidGiveaways && s.prepaidGiveaways.length > 0) {
        lines.push(`\nPrepaid giveaways (${s.prepaidGiveaways.length}):`);
        for (const g of s.prepaidGiveaways) {
          const detail = g.kind === "premium" ? `${g.months}mo premium` : `${g.stars} stars`;
          lines.push(`  ${g.id}: ${g.quantity}× ${detail} (boosts: ${g.boosts ?? "?"})`);
        }
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-boosts-list",
    description:
      "List the boosts applied to a channel/supergroup. Returns paginated boost entries with id, userId (or undefined for anonymous gift boosts), date, expires, flags (gift, giveaway, unclaimed), optional giveawayMsgId, usedGiftSlug, multiplier, and stars. Requires channel admin permissions. Supports pagination via nextOffset and an optional gifts filter to show only gift boosts.",
    inputSchema: {
      chatId: z.string().describe("Channel or supergroup to query — id or @username"),
      gifts: z.boolean().optional().describe("If true, return only gift boosts"),
      offset: z.string().optional().describe("Pagination cursor returned as nextOffset from the previous call"),
      limit: z.number().int().min(1).max(100).default(50).describe("Max boosts per page (1-100, default 50)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, gifts, offset, limit }, { telegram }) => {
      const r = await telegram.getBoostsList(chatId, { gifts, offset, limit });
      if (r.boosts.length === 0) return textResult("No boosts.");
      const lines = [`${r.count} total boosts${r.nextOffset ? ` (more available; nextOffset=${r.nextOffset})` : ""}:`];
      for (const b of r.boosts) {
        const flags = [b.gift ? "gift" : "", b.giveaway ? "giveaway" : "", b.unclaimed ? "unclaimed" : ""]
          .filter(Boolean)
          .join(",");
        const tag = flags ? ` [${flags}]` : "";
        const x = b.multiplier && b.multiplier > 1 ? ` ×${b.multiplier}` : "";
        lines.push(`  ${b.id}: user=${b.userId ?? "anon"} from ${b.date} until ${b.expires}${x}${tag}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-sessions",
    description:
      "Get list of all active Telegram sessions (logged-in devices) with device info, IP, and last active time",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, { telegram }) => {
      const sessions = await telegram.getActiveSessions();
      if (sessions.length === 0) return textResult("No active sessions");
      const text = sessions
        .map(
          (s) =>
            `${s.current ? "→ " : "  "}${s.device} (${s.platform}) — ${s.appName} ${s.appVersion}\n    IP: ${s.ip} (${s.country}) | Last active: ${s.dateActive}${s.current ? " [CURRENT]" : ""}\n    Hash: ${s.hash}`,
        )
        .join("\n\n");
      return textResult(sanitize(text));
    },
  },
];
