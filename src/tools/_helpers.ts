import { z } from "zod";

/** Remove unpaired UTF-16 surrogates that break JSON serialization */
export function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Sanitize an optional free-text field, preserving `undefined` so spread-args don't clobber defaults. */
export const safeOpt = (v: string | undefined): string | undefined => (v === undefined ? undefined : sanitize(v));

/** Standard `replyTo` + `topicId` optional zod fields used by every "send-*" tool. */
export const replyTargetFields = {
  replyTo: z.number().int().positive().optional().describe("Message ID to reply to"),
  topicId: z.number().int().positive().optional().describe("Forum topic ID (groups with Topics enabled)"),
} as const;

/** Most cloud tools are read-only — annotate accordingly for ChatGPT/Claude */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// SAFE_WRITE and WRITE share the same MCP annotation shape; the constants are kept distinct
// so call-sites self-document the operator-level intent of the side effect:
//   SAFE_WRITE — local read-state nudges (mark-as-read, mark-dialog-unread). No outbound payload,
//                no money, no content visible to peers.
//   WRITE      — outbound side effects visible to peers or that move balances/state on the wire
//                (reactions, drafts, poll votes, transcription ratings, paid-reaction privacy).

/** Local read-state operations: mark-as-read, mark-dialog-unread. No content reaches peers. */
export const SAFE_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Non-destructive outbound writes: reactions, drafts, votes, ratings, paid-reaction privacy. */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Irreversible state changes: delete content, revoke invite, change chat-wide
 * settings, edit story, clear drafts. Phase 2.1 — gated server-side by
 * `DestructiveGuard` (per-user opt-in toggle + separate daily quota + audit log). */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
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
  const media = m.media ? ` [${m.media.type}${m.media.fileName ? `: ${m.media.fileName}` : ""}]` : "";
  return `[#${m.id}] [${m.date}] ${m.sender}: ${m.text}${media}${formatReactions(m.reactions)}`;
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
