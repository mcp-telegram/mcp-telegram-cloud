import { z } from "zod";

/** Remove unpaired UTF-16 surrogates that break JSON serialization */
export function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Sanitize an optional free-text field, preserving `undefined` so spread-args don't clobber defaults. */
export const safeOpt = (v: string | undefined): string | undefined => (v === undefined ? undefined : sanitize(v));

/**
 * Derive a human-readable tool title from its kebab-case name.
 * `telegram-send-message` → `Send Message`. The leading `telegram-` namespace
 * prefix is dropped (every tool carries it; the directory shows it as noise).
 * The Claude Connectors Directory requires a `title` on every tool; deriving it
 * keeps all tools covered without per-tool boilerplate, while individual tools
 * can still pass an explicit `title` to override (e.g. acronyms like "2FA").
 */
export function deriveTitle(name: string): string {
  return name
    .replace(/^telegram-/, "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Standard `replyTo` + `topicId` optional zod fields used by every "send-*" tool. */
export const replyTargetFields = {
  replyTo: z.number().int().positive().optional().describe("Message ID to reply to"),
  topicId: z.number().int().positive().optional().describe("Forum topic ID (groups with Topics enabled)"),
} as const;

// MCP annotation classes.
//
// Values follow the OpenAI plugin guidelines ("Correct annotation"), which the
// ChatGPT directory review checks tool by tool, and match the MCP hints Claude
// uses for confirmations:
//
//   readOnlyHint    — true only for retrieval, computation or previews that do
//                     not change anything. Posting messages is a write.
//   destructiveHint — true for deletion, overwriting, cancellation, access
//                     revocation and irreversible sends. false only for
//                     additive writes; "the user can undo it" is not a reason.
//   openWorldHint   — true when the tool reaches public or open-ended entities
//                     or arbitrary destinations (other people, public search,
//                     URLs, third-party bots, any public chat by username).
//                     false when it stays inside the account's own chats,
//                     contacts and settings, or needs the account to be an
//                     admin of the chat, even though Telegram is external.
//
// Every class is matched by identity, so copying an object changes behavior;
// see {@link isGuardedDestructive}.

/** Reads only, inside the account: its dialogs, contacts and settings, its own
 * scheduled messages and story views, stats of chats it administers. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Reads only, but reaches beyond the account: public search, any public chat
 * by username (messages, members, topics, polls, reactions), any user's or
 * channel's public profile and stories, public sticker catalogs, arbitrary
 * URLs, translating a message from any of them. */
export const READ_OPEN = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/** Additive and invisible outside the account: creating a folder, linking one
 * more account, rating a transcription. Changing an existing value does not
 * belong here, see {@link CONFIRMED_WRITE_LOCAL}. */
export const LOCAL_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Additive, reaches beyond the account, nothing irreversible: typing
 * indicator, joining a chat, creating an invite link, a forum topic or a
 * business chat link, sending a query to a third-party inline bot, starting a
 * transcription, keeping a private copy of media for download. */
export const OUTBOUND_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/** Overwrites the account's own state: replacing a draft, a folder's chats or
 * the folder order, privacy settings, marking mentions read, story stealth
 * mode, mute/archive/pin/unread state of a dialog, folder tags, default
 * reaction, the active linked account. `destructiveHint: true` so hosts confirm first,
 * but NOT behind `DestructiveGuard` — nothing is deleted, the user can set the
 * value again. See {@link isGuardedDestructive}. */
export const CONFIRMED_WRITE_LOCAL = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

/** Irreversible sends and overwrites other people see: sending, forwarding or
 * editing messages and media, reactions, votes, read receipts, pins, invites,
 * admin and group settings, unbanning, unblocking, pinned stories, profile and
 * business fields, bot actions. Same split as {@link CONFIRMED_WRITE_LOCAL}: hosts confirm,
 * the server does not gate. */
export const CONFIRMED_WRITE_PUBLIC = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

const CONFIRMED_WRITES: ReadonlySet<object> = new Set([CONFIRMED_WRITE_LOCAL, CONFIRMED_WRITE_PUBLIC]);

/** Whether a tool goes through `DestructiveGuard` (opt-in, quota, audit). Only
 * real deletions do: the two CONFIRMED_WRITE classes carry `destructiveHint`
 * for the host's confirmation but must stay usable without the opt-in. Matched
 * by identity, so a copied object falls back to the stricter gated path. */
export function isGuardedDestructive(annotations: { readonly destructiveHint: boolean }): boolean {
  return annotations.destructiveHint && !CONFIRMED_WRITES.has(annotations);
}

/** Irreversible, but confined to this account: clearing drafts, deleting a
 * folder or a not-yet-sent scheduled message, detaching a linked account.
 * Gated server-side by `DestructiveGuard` (per-user opt-in + daily quota +
 * audit log). */
export const DESTRUCTIVE_LOCAL = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

/** Irreversible and visible to others: deleting sent messages or stories,
 * banning and kicking, revoking an invite link, filing a report, spending
 * Stars. Same `DestructiveGuard` gate as above. */
export const DESTRUCTIVE_PUBLIC = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

/** Format reactions array into compact text like: [👍×5 ❤️×3(me) 🔥×1] */
export function formatReactions(reactions?: { emoji: string; count: number; me: boolean }[]): string {
  if (!reactions?.length) return "";
  const parts = reactions.map((r) => `${r.emoji}×${r.count}${r.me ? "(me)" : ""}`);
  return ` [${parts.join(" ")}]`;
}

export function renderMessage(m: {
  id: number;
  date: string | number;
  sender: string;
  text: string;
  media?: { type: string; fileName?: string };
  reactions?: { emoji: string; count: number; me: boolean }[];
}): string {
  return `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${formatMediaSuffix(m.media)}${formatReactions(m.reactions)}`;
}

/**
 * Media suffix of a message line, like " [photo]" or " [document: a.pdf]".
 * Link previews ("webpage", core 1.44.2+) stay hidden while the directory review freeze keeps the
 * read-messages / search-messages output format fixed; show them once the freeze ends.
 */
export function formatMediaSuffix(media?: { type: string; fileName?: string }): string {
  if (!media || media.type === "webpage") return "";
  return ` [${media.type}${media.fileName ? `: ${media.fileName}` : ""}]`;
}

/** Reply of telegram-mark-as-read; forums also report how their topics were marked */
export function formatMarkAsReadResult(
  chatId: string,
  r: {
    topicsMarked?: number;
    topicsFailed?: number;
    topicError?: string;
    topicsRemaining?: number;
    topicsNotChecked?: boolean;
  },
): string {
  let text = `Marked ${chatId} as read`;
  if (r.topicsMarked !== undefined) text += ` (${r.topicsMarked} unread topics marked)`;
  if (r.topicsFailed) text += `. ${r.topicsFailed} topics could not be marked: ${r.topicError}`;
  else if (r.topicError) text += `. Stopped early: ${r.topicError}`;
  if (r.topicsRemaining) text += `. ${r.topicsRemaining} more unread topics left, call again to mark them`;
  if (r.topicsNotChecked) {
    text += ". The forum has more topics than one call checks; call again to continue with the rest";
  }
  return text;
}

export function renderDialog(d: {
  type: string;
  name: string;
  id: string | number;
  isBot?: boolean;
  isContact?: boolean;
  unreadCount: number;
}): string {
  const prefix = d.type === "group" ? "G" : d.type === "channel" ? "C" : "P";
  const botTag = d.isBot ? " [bot]" : "";
  const contactTag = d.type === "private" && d.isContact === false ? " [not in contacts]" : "";
  const unread = d.unreadCount > 0 ? ` [${d.unreadCount} unread]` : "";
  return `${prefix} ${d.name} (${d.id})${botTag}${contactTag}${unread}`;
}

function renderStoryMeta(s: {
  date?: string | number;
  mediaType?: string;
  pinned?: boolean;
  public?: boolean;
}): string {
  return [s.date ? `at ${s.date}` : "", s.mediaType ?? "", s.pinned ? "pinned" : "", s.public ? "public" : ""]
    .filter(Boolean)
    .join(", ");
}

/** Render a story snippet line: `[#id] kind (meta)[: caption]` (caption truncated to 80 chars). */
export function renderStorySnippet(s: {
  id: number;
  kind: string;
  caption?: string;
  date?: string | number;
  mediaType?: string;
  pinned?: boolean;
  public?: boolean;
}): string {
  const cap = s.caption ? `: ${s.caption.slice(0, 80)}` : "";
  return `  [#${s.id}] ${s.kind} (${renderStoryMeta(s)})${cap}`;
}

/** Format a CompactPeer as `kind:id` (or fallback when peer is missing). */
export function formatPeer(peer: { kind: string; id: string | number } | null | undefined, fallback = "?"): string {
  return peer ? `${peer.kind}:${peer.id}` : fallback;
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Build a CallToolResult error wrapper for preValidate / onError shorthand returns. */
export function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Telegram's hard cap for one message's text, in UTF-16 code units — the unit `String.length`
 * counts and the unit MTProto measures. Media captions are capped lower (1024) and are
 * enforced separately by the upload tools.
 */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * `preValidate` guard for message text length.
 *
 * Without it an over-long message costs a full MTProto round-trip and comes back as the
 * opaque `400: MESSAGE_TOO_LONG (caused by messages.SendMessage)` — the single most common
 * `telegram-send-message` failure in production (18 of 22 errors over 7 days), because LLM
 * clients have no feel for the 4096 cap. Reporting the measured length and the overshoot
 * lets the caller fix it in one step instead of guessing.
 *
 * Deliberately NOT auto-splitting: silently turning one requested message into three is a
 * visible, unrequested action in someone else's chat.
 *
 * Returns null (defer to Telegram) whenever `parseMode` is set — see the comment inside.
 */
export function checkMessageLength(text: string, parseMode?: string) {
  // Telegram applies the cap to the PARSED message, not to the markup source: GramJS strips
  // `<b>`/`**` into entities before sending, so a 4097-char HTML source can carry a legal
  // 4090-char message. Since parsed <= raw, `raw <= limit` always implies the message fits,
  // but `raw > limit` proves nothing once markup is in play. Rather than reimplement the
  // GramJS parsers here, only decide locally when raw and parsed are the same string, and
  // otherwise leave the verdict to Telegram (i.e. the pre-existing behaviour).
  if (parseMode) return null;
  if (text.length <= MAX_MESSAGE_LENGTH) return null;
  const over = text.length - MAX_MESSAGE_LENGTH;
  return errorResult(
    `Message text is ${text.length} characters — Telegram's limit is ${MAX_MESSAGE_LENGTH} (${over} over). ` +
      "Split it into separate messages, or send it as a file with telegram-send-file.",
  );
}

/**
 * Build an `onError` mapper that converts Telegram's PREMIUM/PAYMENT_REQUIRED faults into a
 * single human-readable message. Returns `null` for unrelated errors so the default mapper runs.
 * Use for tools whose only Telegram-side gating is "needs Premium" (e.g. emoji status, stealth mode).
 */
export const premiumOnlyOnError = (message: string) => (e: unknown) => {
  const msg = (e as Error).message ?? "";
  return /PREMIUM|PAYMENT_REQUIRED/i.test(msg) ? errorResult(message) : null;
};

/**
 * Build an `onError` mapper for Telegram Business-gated tools. Same shape as `premiumOnlyOnError`
 * but the regex also matches BUSINESS to cover Telegram's mixed PREMIUM/BUSINESS error vocabulary.
 */
export const businessOnlyOnError = (message: string) => (e: unknown) => {
  const msg = (e as Error).message ?? "";
  return /PREMIUM|PAYMENT_REQUIRED|BUSINESS/i.test(msg) ? errorResult(message) : null;
};

/** Format a group-call participant line. Surfaces every flag the upstream summary advertises. */
export function renderGroupCallParticipant(p: {
  peer?: { kind: string; id: string | number };
  source: number;
  volume?: number;
  muted?: boolean;
  left?: boolean;
  self?: boolean;
  mutedByYou?: boolean;
  videoJoined?: boolean;
  justJoined?: boolean;
  hasVideo?: boolean;
  hasPresentation?: boolean;
  raiseHandRating?: string;
  about?: string;
}): string {
  const flags = [
    p.muted ? "muted" : "",
    p.mutedByYou ? "mutedByYou" : "",
    p.left ? "left" : "",
    p.self ? "self" : "",
    p.videoJoined ? "videoJoined" : "",
    p.hasVideo ? "video" : "",
    p.hasPresentation ? "presentation" : "",
    p.justJoined ? "justJoined" : "",
  ]
    .filter(Boolean)
    .join(",");
  const vol = p.volume !== undefined ? ` vol=${p.volume}` : "";
  const raise = p.raiseHandRating ? ` raise=${p.raiseHandRating}` : "";
  const about = p.about ? ` about="${p.about}"` : "";
  return `  ${formatPeer(p.peer ?? null)} src=${p.source}${flags ? ` [${flags}]` : ""}${vol}${raise}${about}`;
}

export const MAX_INLINE_MEDIA = 950_000; // ~950KB to stay under 1MB base64 limit
