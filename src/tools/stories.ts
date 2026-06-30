import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import {
  DESTRUCTIVE,
  errorResult,
  formatPeer,
  premiumOnlyOnError,
  READ_ONLY,
  renderStorySnippet,
  sanitize,
  textResult,
  WRITE,
} from "./helpers.js";

/** Curated text for the multi-step report flow result (ReportResultSummary).
 * Replaces a raw JSON dump. The base64 `option` bytes are preserved VERBATIM —
 * the caller passes them back as `option` on the next step. */
function renderReportResult(
  r:
    | { kind: "reported" }
    | { kind: "chooseOption"; title?: string; options: Array<{ text: string; option: string }> }
    | { kind: "addComment"; optional?: boolean },
): string {
  if (r.kind === "reported") return "Report submitted.";
  if (r.kind === "addComment") {
    return `Add a comment to continue the report${r.optional ? " (optional)" : " (required)"} — call again with your message.`;
  }
  const lines = [r.title ? `Choose a report reason — ${r.title}:` : "Choose a report reason:"];
  for (const o of r.options) lines.push(`  - ${o.text} → option=${o.option}`);
  return lines.join("\n");
}

export const STORIES_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-get-all-stories",
    description:
      "Fetch active stories from contacts/channels the user follows. Pagination via 'next' + 'state' — pass the returned state back on the next call with next:true to load more. Use hidden:true to read stories from muted/archived peers. Returns compact story metadata (id, date, expireDate, caption, mediaType, counters) without raw media blobs.",
    inputSchema: {
      next: z.boolean().optional().describe("Load the next page (use with state from a prior response)"),
      hidden: z.boolean().optional().describe("Fetch stories from hidden/archived peers instead of the main feed"),
      state: z.string().optional().describe("Pagination state token returned by a previous call"),
    },
    annotations: READ_ONLY,
    preValidate: ({ next, state }) => {
      if (next === true && !state) {
        return errorResult(
          "'state' is required when 'next' is true — use the state token from a prior telegram-get-all-stories response",
        );
      }
      return null;
    },
    handler: async ({ next, hidden, state }, { telegram }) => {
      const r = await telegram.getAllStories({ next, hidden, state });
      const lines = [
        `State: ${r.state} (modified=${r.modified}, hasMore=${r.hasMore ?? false}, count=${r.count ?? "?"})`,
      ];
      if (r.stealthMode) {
        lines.push(
          `Stealth mode: active until ${r.stealthMode.activeUntilDate ?? "n/a"}, cooldown ${r.stealthMode.cooldownUntilDate ?? "n/a"}`,
        );
      }
      for (const ps of r.peerStories) {
        lines.push(`\nPeer ${formatPeer(ps.peer)} (maxRead=${ps.maxReadId ?? "n/a"}):`);
        for (const s of ps.stories) lines.push(renderStorySnippet(s));
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-peer-stories",
    description:
      "Fetch currently active stories posted by a specific peer (user/channel). Returns compact story metadata (id, date, expireDate, caption, mediaType, counters) without raw media blobs. Use telegram-download-media with the story id if you need media bytes.",
    inputSchema: {
      chatId: z.string().describe("Peer to fetch stories from — user/channel id or @username"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId }, { telegram }) => {
      const r = await telegram.getPeerStories(chatId);
      if (!r) return textResult("No stories from this peer.");
      const lines = [`Peer ${formatPeer(r.peer)} (maxRead=${r.maxReadId ?? "n/a"}), ${r.stories.length} story(ies):`];
      for (const s of r.stories) {
        const counters = s.viewsCount != null ? ` [${s.viewsCount} views, ${s.reactionsCount ?? 0} reactions]` : "";
        lines.push(`${renderStorySnippet(s)}${counters}`);
      }
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-stories-by-id",
    description:
      "Fetch specific stories from a peer by their numeric IDs. Useful for retrieving archived/pinned stories outside the active feed. Returns compact story metadata and optional pinnedToTop list. Pass up to 100 ids per request.",
    inputSchema: {
      chatId: z.string().describe("Peer to fetch stories from — user/channel id or @username"),
      ids: z.array(z.number().int().positive()).min(1).max(100).describe("Story IDs to fetch (1-100 per request)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, ids }, { telegram }) => {
      const r = await telegram.getStoriesById(chatId, ids);
      const lines = [`${r.count} story(ies):`];
      if (r.pinnedToTop && r.pinnedToTop.length > 0) lines.push(`Pinned to top: ${r.pinnedToTop.join(", ")}`);
      for (const s of r.stories) lines.push(renderStorySnippet(s));
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-get-story-views",
    description:
      "List viewers of one of YOUR stories. Returns per-viewer entries (user id, view date, their reaction emoji if any), plus totals (viewsCount, forwardsCount, reactionsCount) and nextOffset for pagination. This only works for stories you posted. Some accounts (non-Premium, old stories) may not get a full viewer list.",
    inputSchema: {
      chatId: z.string().describe("Peer owning the story — usually 'me' or your own user id/@username"),
      storyId: z.number().int().positive().describe("Story ID to fetch viewers for"),
      q: z.string().optional().describe("Filter viewers by name substring"),
      justContacts: z.boolean().optional().describe("Return only contacts"),
      reactionsFirst: z.boolean().optional().describe("Sort viewers who reacted first"),
      forwardsFirst: z.boolean().optional().describe("Sort forwards/reposts first"),
      offset: z.string().optional().describe("Pagination cursor from previous call"),
      limit: z.number().int().min(1).max(100).default(50).describe("Max viewers per page (1-100)"),
    },
    annotations: READ_ONLY,
    handler: async (
      { chatId, storyId, q, justContacts, reactionsFirst, forwardsFirst, offset, limit },
      { telegram },
    ) => {
      const r = await telegram.getStoryViewsList(chatId, {
        id: storyId,
        q,
        justContacts,
        reactionsFirst,
        forwardsFirst,
        offset,
        limit,
      });
      const lines = [
        `Story #${storyId}: ${r.count} viewers (${r.viewsCount} views, ${r.forwardsCount} forwards, ${r.reactionsCount} reactions)${r.nextOffset ? `, nextOffset=${r.nextOffset}` : ""}`,
      ];
      for (const v of r.views) {
        if (v.kind === "user") {
          const reaction = v.reaction ? ` ${v.reaction}` : "";
          const blocked = v.blocked ? " [blocked]" : "";
          lines.push(`  user ${v.userId} at ${v.date}${reaction}${blocked}`);
        } else if (v.kind === "publicForward") {
          lines.push(`  forward to ${formatPeer(v.peer)} (msg ${v.messageId ?? "?"})`);
        } else {
          lines.push(`  repost from ${formatPeer(v.peer)} (story ${v.storyId ?? "?"})`);
        }
      }
      return textResult(sanitize(lines.join("\n")));
    },
    onError: premiumOnlyOnError("Story view stats may require Telegram Premium."),
  },

  {
    name: "telegram-get-stories-archive",
    description:
      "Fetch auto-archived (expired) stories from a peer's archive. Paginate via offsetId (pass last story id from previous page).",
    inputSchema: {
      chatId: z.string().default("me").describe("Peer whose archive to fetch (default: 'me')"),
      offsetId: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe("Pagination cursor — last story id from previous page (0 to start)"),
      limit: z.number().int().min(1).max(100).default(50).describe("Max stories to return (1-100, default 50)"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, offsetId, limit }, { telegram }) => {
      const r = await telegram.getStoriesArchive(chatId, offsetId, limit);
      if (r.stories.length === 0) return textResult("No archived stories.");
      const lines = [`${r.count} archived story(ies):`];
      for (const s of r.stories) lines.push(renderStorySnippet(s));
      return textResult(sanitize(lines.join("\n")));
    },
  },

  {
    name: "telegram-export-story-link",
    description: "Get a shareable t.me/… URL for a public story.",
    inputSchema: {
      chatId: z.string().describe("Peer who posted the story"),
      storyId: z.number().int().positive().describe("Story ID to get the link for"),
    },
    annotations: READ_ONLY,
    handler: async ({ chatId, storyId }, { telegram }) => {
      const r = await telegram.exportStoryLink(chatId, storyId);
      return textResult(sanitize(r.link));
    },
  },

  {
    name: "telegram-toggle-story-pinned",
    description: "Pin or unpin stories in your profile highlights (Telegram allows up to 3 pinned stories).",
    inputSchema: {
      chatId: z.string().default("me").describe("Peer owning the stories"),
      ids: z.array(z.number().int().positive()).min(1).max(100).describe("Story IDs to pin or unpin"),
      pinned: z.boolean().describe("true to pin, false to unpin"),
    },
    annotations: WRITE,
    handler: async ({ chatId, ids, pinned }, { telegram }) => {
      const result = await telegram.toggleStoryPinned(chatId, ids, pinned);
      const { affected } = result;
      return textResult(
        `${pinned ? "Pinned" : "Unpinned"} ${affected.length} stor${affected.length === 1 ? "y" : "ies"}: [${affected.join(", ")}]`,
      );
    },
  },

  {
    name: "telegram-toggle-story-pinned-to-top",
    description:
      "Pin stories to the very top of your pinned row. Pass an empty array [] to clear all top-pinned stories.",
    inputSchema: {
      chatId: z.string().default("me").describe("Peer owning the stories"),
      ids: z.array(z.number().int().positive()).max(100).describe("Story IDs to pin to the top row; pass [] to clear"),
    },
    annotations: WRITE,
    handler: async ({ chatId, ids }, { telegram }) => {
      await telegram.toggleStoryPinnedToTop(chatId, ids);
      return textResult(
        ids.length === 0
          ? "Cleared top-pinned stories"
          : `Pinned ${ids.length} stor${ids.length === 1 ? "y" : "ies"} to top: [${ids.join(", ")}]`,
      );
    },
  },

  {
    name: "telegram-read-stories",
    description: "Mark stories as seen up to a given story ID (maxId, inclusive).",
    inputSchema: {
      chatId: z.string().describe("Peer whose stories to mark as seen"),
      maxId: z.number().int().positive().describe("Stories up to and including this ID will be marked seen"),
    },
    annotations: WRITE,
    handler: async ({ chatId, maxId }, { telegram }) => {
      const result = await telegram.readStories(chatId, maxId);
      return textResult(`Marked stories as read up to #${maxId} (${result.ids.length} newly seen)`);
    },
  },

  {
    name: "telegram-report-story",
    description:
      "Report a story via the multi-step option flow. First call with option:'' starts the flow; subsequent calls pass the base64 option bytes from the previous response.",
    inputSchema: {
      chatId: z.string().describe("Peer who posted the story"),
      ids: z.array(z.number().int().positive()).min(1).max(100).describe("Story IDs to report"),
      option: z
        .string()
        .max(128)
        .default("")
        .describe("Base64-encoded option bytes from a prior report step, or empty string to start the flow"),
      message: z.string().max(1024).default("").describe("Optional message to accompany the report"),
    },
    annotations: WRITE,
    handler: async ({ chatId, ids, option, message }, { telegram }) => {
      const result = await telegram.reportStory(chatId, ids, option, sanitize(message));
      return textResult(sanitize(renderReportResult(result)));
    },
  },

  {
    name: "telegram-activate-stealth-mode",
    description:
      "Hide your story views retroactively (past=true) and/or for the next 25 minutes (future=true). Requires Telegram Premium — non-Premium accounts receive PREMIUM_ACCOUNT_REQUIRED.",
    inputSchema: {
      past: z.boolean().optional().describe("Remove your views from stories you already watched"),
      future: z.boolean().optional().describe("Hide your views for the next 25 minutes"),
    },
    annotations: WRITE,
    preValidate: ({ past, future }) => {
      if (!past && !future) return errorResult("At least one of past or future must be true");
      return null;
    },
    handler: async ({ past, future }, { telegram }) => {
      await telegram.activateStealthMode(past, future);
      return textResult(`Stealth mode activated (past: ${past ?? false}, future: ${future ?? false})`);
    },
    onError: premiumOnlyOnError("Stealth mode requires Telegram Premium."),
  },

  // ─── Destructive (Phase 2.1, gated by DestructiveGuard) ─────────────────
  {
    name: "telegram-delete-stories",
    description: "Delete one or more of your own stories. Irreversible — requires confirm:true.",
    inputSchema: {
      chatId: z.string().default("me").describe("Peer owning the stories"),
      ids: z.array(z.number().int().positive()).min(1).max(100).describe("Story IDs to delete (1-100 per request)"),
      confirm: z.literal(true).describe("Pass true to confirm irreversible deletion"),
    },
    annotations: DESTRUCTIVE,
    handler: async ({ chatId, ids }, { telegram }) => {
      const result = await telegram.deleteStories(chatId, ids);
      const { deleted } = result;
      return textResult(`Deleted ${deleted.length} stor${deleted.length === 1 ? "y" : "ies"}: [${deleted.join(", ")}]`);
    },
  },

  {
    name: "telegram-edit-story",
    description:
      "Edit an existing story: update caption ('' clears it) or change privacy rules. Cloud disallows replacing the media file (filesystem-bound) — use a fresh story for media changes.",
    inputSchema: {
      chatId: z.string().default("me").describe("Peer owning the story"),
      storyId: z.number().int().positive().describe("ID of the story to edit"),
      caption: z.string().max(2048).optional().describe("New caption; pass '' to clear"),
      parseMode: z.enum(["md", "html"]).optional().describe("Caption parse mode"),
      privacy: z.enum(["everyone", "contacts", "close_friends", "selected"]).optional().describe("New privacy setting"),
      allowUserIds: z
        .array(z.string().regex(/^\d{1,19}$/, "must be a numeric Telegram user ID"))
        .optional()
        .describe("Required when privacy='selected'"),
      disallowUserIds: z
        .array(z.string().regex(/^\d{1,19}$/, "must be a numeric Telegram user ID"))
        .optional()
        .describe("Blocked user IDs (ignored for 'selected')"),
    },
    annotations: DESTRUCTIVE,
    preValidate: ({ caption, privacy, allowUserIds }) => {
      if (caption === undefined && privacy === undefined) {
        return errorResult("Provide at least one of: caption, privacy.");
      }
      // Mirror upstream guard (account.js:193-195): privacy='selected' without
      // a non-empty allowUserIds is rejected at the wire; surface it pre-handler
      // so the audit log records the validation refusal, not a wire-level error.
      if (privacy === "selected" && (!allowUserIds || allowUserIds.length === 0)) {
        return errorResult("privacy='selected' requires at least one user ID in allowUserIds.");
      }
      return null;
    },
    handler: async ({ chatId, storyId, caption, parseMode, privacy, allowUserIds, disallowUserIds }, { telegram }) => {
      const opts: {
        caption?: string;
        parseMode?: "md" | "html";
        privacy?: "everyone" | "contacts" | "close_friends" | "selected";
        allowUserIds?: string[];
        disallowUserIds?: string[];
      } = {};
      if (caption !== undefined) opts.caption = sanitize(caption);
      if (parseMode !== undefined) opts.parseMode = parseMode;
      if (privacy !== undefined) opts.privacy = privacy;
      if (allowUserIds !== undefined) opts.allowUserIds = allowUserIds;
      if (disallowUserIds !== undefined) opts.disallowUserIds = disallowUserIds;
      const result = await telegram.editStory(chatId, storyId, opts);
      return textResult(`Edited story #${storyId} in ${chatId}: ${result.changed.join(", ") || "no changes"}`);
    },
  },
];
