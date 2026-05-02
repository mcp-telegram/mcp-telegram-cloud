import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "../tool-registry.js";
import { errorResult, replyTargetFields, safeOpt, sanitize, textResult, WRITE } from "./_helpers.js";

/**
 * Phase X — FS-bound media tools backed by user-provided uploads or HTTPS URLs.
 *
 * All 6 tools share the same shape: a `source` field that is either
 *   { kind: "upload", uploadId: "upl_..." }   — bytes the user POSTed to /my/upload
 *   { kind: "url",    url: "https://..." }     — HTTPS URL the cloud fetches via SSRF guard
 * The resolver materializes a temp file, hands its absolute path to upstream,
 * then unlinks it — upstream methods take only `filePath: string`.
 */

const sourceSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upload"),
      uploadId: z
        .string()
        .min(1)
        .describe(
          "Opaque upload ID returned by POST /my/upload (e.g. 'upl_a8f3...'). User-scoped, single-use, expires in ~15min.",
        ),
    }),
    z.object({
      kind: z.literal("url"),
      url: z
        .string()
        .url()
        .describe(
          "HTTPS URL the cloud fetches with SSRF protection. Private/loopback addresses are rejected. Max ~50MB.",
        ),
    }),
  ])
  .describe(
    "Where to get the file bytes. Either an upload ID (user uploaded via /my/upload) or an https:// URL (the cloud fetches it).",
  );

type SourceArg = z.infer<typeof sourceSchema>;

interface ResolvedSource {
  /** Absolute temp file path to hand to the upstream Telegram method. */
  path: string;
  /** Cleanup function — call after the upstream method finishes (success or failure). */
  cleanup: () => Promise<void>;
  /** Caller-supplied original filename if known (helps Telegram pick MIME). */
  originalName: string | null;
  /** MIME we believe the bytes carry, or "application/octet-stream" if unknown. */
  mime: string;
}

/** Subdirectory under `os.tmpdir()` where URL-fetch payloads land. Distinct from
 * UPLOAD_DIR_NAME (those are user-uploaded; these are fetched on the user's behalf
 * and are short-lived — deleted as soon as the tool handler returns). */
const URL_FETCH_DIR_NAME = "mcp-telegram-cloud-urlfetch";

/** Wipe URL-fetch temp files older than `maxAgeMs`. Called at boot + on a timer
 * from server.tsx to mop up orphans (mode failures, SIGKILL between writeFile
 * and cleanup, etc.). Returns count purged. Safe to call when the directory
 * doesn't exist yet. */
export async function purgeUrlFetchOrphans(maxAgeMs: number): Promise<number> {
  const dir = join(tmpdir(), URL_FETCH_DIR_NAME);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist → no orphans.
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (st.mtimeMs < cutoff) {
        await unlink(full);
        removed++;
      }
    } catch {
      // Race with concurrent purge or external cleanup — treat as already-gone.
    }
  }
  return removed;
}

const UPLOAD_NOT_AVAILABLE =
  "Upload tools require server config (uploads + URL fetcher). This is a deploy bug; report it to the operator.";

const USER_NOT_AVAILABLE = "Upload tools require an authenticated user context (cookie or OAuth bearer).";

const UPLOAD_NOT_FOUND =
  "Upload not found. The ID is wrong, expired (15min TTL), already consumed, or belongs to another account. Re-upload via /my/upload.";

/**
 * Resolve a source argument into a real temp file. Returns either a usable
 * {path, cleanup, ...} or an errorResult to short-circuit the tool.
 *
 * Cleanup contract: every caller invokes `cleanup()` from a `finally` block,
 * so cleanup runs on BOTH success and handler failure. consume() (upload kind)
 * and unlink-and-ignore (url kind) are idempotent — safe to double-call if the
 * caller ever changes the pattern. A handler-side failure does NOT preserve the
 * upload for retry; the user would re-POST to /my/upload.
 *
 * On `kind: "upload"`: cleanup invokes UploadStore.consume() which deletes the
 * row + unlinks the file in one shot.
 *
 * On `kind: "url"`: SSRF-fetch into a fresh temp file, unlink in cleanup.
 */
async function resolveSource(
  source: SourceArg,
  deps: ToolDeps,
): Promise<{ ok: true; resolved: ResolvedSource } | { ok: false; error: ReturnType<typeof errorResult> }> {
  if (!deps.uploads || !deps.fetchUrl) {
    return { ok: false, error: errorResult(UPLOAD_NOT_AVAILABLE) };
  }
  if (!deps.userId) {
    return { ok: false, error: errorResult(USER_NOT_AVAILABLE) };
  }

  if (source.kind === "upload") {
    const row = deps.uploads.resolve(deps.userId, source.uploadId);
    if (!row) {
      return { ok: false, error: errorResult(UPLOAD_NOT_FOUND) };
    }
    const userId = deps.userId;
    const uploadId = source.uploadId;
    const uploads = deps.uploads;
    return {
      ok: true,
      resolved: {
        path: row.tmp_path,
        originalName: row.original_name,
        mime: row.mime,
        cleanup: async () => {
          // consume() deletes row + unlinks the file. Idempotent.
          await uploads.consume(userId, uploadId);
        },
      },
    };
  }

  // kind: "url" — SSRF-validated fetch into a one-shot temp file.
  // Two caps applied: (a) per-file ceiling (UploadStore.fileMaxBytesCap), and
  // (b) remaining per-user quota — `quotaBytes - currently-pending`. This keeps a
  // user from triggering 10× near-cap URL fetches in parallel album items, since
  // the in-flight bytes still count against the same disk-pressure budget as
  // user-uploaded `pending_uploads`. Concurrent calls race on the SUM (M6 noted
  // the same race for `put`); the worst case here is one extra near-cap fetch.
  const remaining = Math.max(0, deps.uploads.quotaBytesCap - deps.uploads.pendingBytesForUser(deps.userId));
  const cap = Math.min(deps.uploads.fileMaxBytesCap, remaining);
  if (cap <= 0) {
    return {
      ok: false,
      error: errorResult(
        `URL fetch denied: per-user upload quota exhausted (${deps.uploads.pendingBytesForUser(deps.userId)} bytes already pending). Wait for TTL purge or consume a pending upload.`,
      ),
    };
  }
  const fetched = await deps.fetchUrl(source.url, { maxBytes: cap });
  if (!fetched.ok) {
    return { ok: false, error: errorResult(`URL fetch denied (${fetched.reason}): ${fetched.message}`) };
  }
  const dir = join(tmpdir(), URL_FETCH_DIR_NAME);
  // mode 0o700 — directory listable only by the cloud process owner. Files inside
  // are 0o600. Defense-in-depth against shared `/tmp` in multi-tenant containers.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `urlfetch_${randomUUID().replace(/-/g, "")}`);
  await writeFile(path, fetched.bytes, { mode: 0o600 });
  return {
    ok: true,
    resolved: {
      path,
      originalName: null,
      mime: fetched.mime,
      cleanup: async () => {
        try {
          await unlink(path);
        } catch {
          // already gone — fine.
        }
      },
    },
  };
}

const parseModeField = z.enum(["md", "html"]).optional().describe("Caption parse mode: 'md' (Markdown) or 'html'");

const captionField = z.string().optional().describe("Optional caption (truncated client-side as needed)");

export const UPLOAD_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-send-file",
    description:
      "Send a generic file to a chat. Bytes come from a prior /my/upload (uploadId) or an https:// URL the cloud fetches. URL fetch is SSRF-protected. Max ~50MB.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      source: sourceSchema,
      caption: captionField,
    },
    annotations: WRITE,
    handler: async ({ chatId, source, caption }, deps) => {
      const r = await resolveSource(source, deps);
      if (!r.ok) return r.error;
      try {
        await deps.telegram.sendFile(chatId, r.resolved.path, safeOpt(caption));
        return textResult(`Sent file to ${chatId}`);
      } finally {
        await r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-send-voice",
    description:
      "Send a voice message (OGG/Opus preferred; M4A/MP3 also accepted). Bytes from uploadId or https:// URL.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      source: sourceSchema,
      caption: captionField,
      parseMode: parseModeField,
      ...replyTargetFields,
    },
    annotations: WRITE,
    handler: async ({ chatId, source, caption, parseMode, replyTo, topicId }, deps) => {
      const r = await resolveSource(source, deps);
      if (!r.ok) return r.error;
      try {
        const opts: {
          caption?: string;
          parseMode?: "md" | "html";
          replyTo?: number;
          topicId?: number;
        } = {};
        if (caption !== undefined) opts.caption = sanitize(caption);
        if (parseMode !== undefined) opts.parseMode = parseMode;
        if (replyTo !== undefined) opts.replyTo = replyTo;
        if (topicId !== undefined) opts.topicId = topicId;
        const { id } = await deps.telegram.sendVoice(chatId, r.resolved.path, opts);
        return textResult(`Sent voice to ${chatId} (msg #${id})`);
      } finally {
        await r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-send-video-note",
    description:
      "Send a round video note (MP4 preferred, square source for best look). Bytes from uploadId or https:// URL.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      source: sourceSchema,
      // Caps mirror upstream send-media.js:40-46 (Telegram's hard limits).
      duration: z
        .number()
        .int()
        .positive()
        .max(60)
        .optional()
        .describe("Video duration in seconds (Telegram caps at 60)"),
      length: z
        .number()
        .int()
        .positive()
        .max(640)
        .optional()
        .describe("Frame side length in pixels (square-cropped; Telegram caps at 640)"),
      ...replyTargetFields,
    },
    annotations: WRITE,
    handler: async ({ chatId, source, duration, length, replyTo, topicId }, deps) => {
      const r = await resolveSource(source, deps);
      if (!r.ok) return r.error;
      try {
        const opts: { duration?: number; length?: number; replyTo?: number; topicId?: number } = {};
        if (duration !== undefined) opts.duration = duration;
        if (length !== undefined) opts.length = length;
        if (replyTo !== undefined) opts.replyTo = replyTo;
        if (topicId !== undefined) opts.topicId = topicId;
        const { id } = await deps.telegram.sendVideoNote(chatId, r.resolved.path, opts);
        return textResult(`Sent video note to ${chatId} (msg #${id})`);
      } finally {
        await r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-send-album",
    description:
      "Send an album of 1-10 photos/videos to a chat. Each item supplies its own bytes (uploadId or https:// URL) and optional caption.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      items: z
        .array(
          z.object({
            source: sourceSchema,
            caption: captionField,
          }),
        )
        // Mirror upstream send-media.js:235 (.min(2)). A 1-item "album" is a
        // degenerate case Telegram itself rejects — fail at validation, not on the wire.
        .min(2)
        .max(10)
        .describe("2-10 album items (Telegram cap; 1 item is invalid — use telegram-send-file instead)"),
      caption: captionField,
      parseMode: parseModeField,
      ...replyTargetFields,
    },
    annotations: WRITE,
    handler: async ({ chatId, items, caption, parseMode, replyTo, topicId }, deps) => {
      const resolved: ResolvedSource[] = [];
      try {
        for (const item of items) {
          const r = await resolveSource(item.source, deps);
          // Already-resolved items are cleaned up by the `finally` below — no
          // explicit rollback loop needed (cleanup is idempotent either way).
          if (!r.ok) return r.error;
          resolved.push(r.resolved);
        }
        const upstreamItems = resolved.map((res, i) => {
          const itemCaption = items[i]?.caption;
          return itemCaption !== undefined
            ? { filePath: res.path, caption: sanitize(itemCaption) }
            : { filePath: res.path };
        });
        const opts: {
          caption?: string;
          parseMode?: "md" | "html";
          replyTo?: number;
          topicId?: number;
        } = {};
        if (caption !== undefined) opts.caption = sanitize(caption);
        if (parseMode !== undefined) opts.parseMode = parseMode;
        if (replyTo !== undefined) opts.replyTo = replyTo;
        if (topicId !== undefined) opts.topicId = topicId;
        const { ids } = await deps.telegram.sendAlbum(chatId, upstreamItems, opts);
        return textResult(`Sent album of ${ids.length} to ${chatId} (msgs #${ids.join(",")})`);
      } finally {
        for (const r of resolved) await r.cleanup();
      }
    },
  },

  {
    name: "telegram-send-story",
    description:
      "Post a story to your profile or a channel. Bytes from uploadId or https:// URL. Caller picks privacy explicitly.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username (channel) or 'me' for your own profile"),
      source: sourceSchema,
      type: z.enum(["photo", "video"]).optional().describe("Force media type if MIME-sniff is wrong"),
      // Cap matches upstream stories.js:115 (.max(2048)).
      caption: z.string().max(2048).optional().describe("Optional caption (max 2048 chars)"),
      parseMode: parseModeField,
      // Cloud convention: write tools require privacy explicitly (no implicit default).
      // Upstream defaults to "everyone"; cloud forces the LLM to state the audience.
      privacy: z
        .enum(["everyone", "contacts", "close_friends", "selected"])
        .describe("Audience for this story (matches upstream StoryPrivacy). No default — must be explicit."),
      allowUserIds: z
        .array(z.string().regex(/^\d{1,19}$/, "must be a numeric Telegram user ID"))
        .optional()
        .describe("Required when privacy='selected'"),
      disallowUserIds: z
        .array(z.string().regex(/^\d{1,19}$/, "must be a numeric Telegram user ID"))
        .optional()
        .describe("Blocked user IDs (ignored for 'selected')"),
      // Mirror upstream stories.js:130 — Telegram only accepts these 4 lifetimes.
      period: z
        .union([z.literal(21600), z.literal(43200), z.literal(86400), z.literal(172800)])
        .optional()
        .describe("Story lifetime in seconds: 21600=6h, 43200=12h, 86400=24h, 172800=48h"),
      pinned: z.boolean().optional().describe("Pin to profile after expiry"),
      noforwards: z.boolean().optional().describe("Disable forwarding"),
    },
    annotations: WRITE,
    preValidate: ({ privacy, allowUserIds }) => {
      // Mirror upstream guard (account.js:193-195): privacy='selected' without
      // a non-empty allowUserIds is rejected at the wire; surface it pre-handler.
      if (privacy === "selected" && (!allowUserIds || allowUserIds.length === 0)) {
        return errorResult("privacy='selected' requires at least one user ID in allowUserIds.");
      }
      return null;
    },
    handler: async (
      { chatId, source, type, caption, parseMode, privacy, allowUserIds, disallowUserIds, period, pinned, noforwards },
      deps,
    ) => {
      const r = await resolveSource(source, deps);
      if (!r.ok) return r.error;
      try {
        const opts: {
          type?: "photo" | "video";
          caption?: string;
          parseMode?: "md" | "html";
          privacy: "everyone" | "contacts" | "close_friends" | "selected";
          allowUserIds?: string[];
          disallowUserIds?: string[];
          period?: number;
          pinned?: boolean;
          noforwards?: boolean;
        } = { privacy };
        if (type !== undefined) opts.type = type;
        if (caption !== undefined) opts.caption = sanitize(caption);
        if (parseMode !== undefined) opts.parseMode = parseMode;
        if (allowUserIds !== undefined) opts.allowUserIds = allowUserIds;
        if (disallowUserIds !== undefined) opts.disallowUserIds = disallowUserIds;
        if (period !== undefined) opts.period = period;
        if (pinned !== undefined) opts.pinned = pinned;
        if (noforwards !== undefined) opts.noforwards = noforwards;
        const { id, period: actualPeriod } = await deps.telegram.sendStory(chatId, r.resolved.path, opts);
        return textResult(`Sent story to ${chatId} (id=${id ?? "?"}, period=${actualPeriod}s)`);
      } finally {
        await r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-set-profile-photo",
    description:
      "Set your Telegram profile photo (image or short MP4). Bytes from uploadId or https:// URL. fallback=true sets the photo shown when your account is private.",
    inputSchema: {
      source: sourceSchema,
      isVideo: z.boolean().describe("true if source is a short MP4, false for a still image"),
      videoStartTs: z.number().nonnegative().optional().describe("Seconds into the video to use as the still preview"),
      fallback: z.boolean().describe("If true, set as the public-fallback photo (shown to non-contacts)"),
    },
    annotations: WRITE,
    handler: async ({ source, isVideo, videoStartTs, fallback }, deps) => {
      const r = await resolveSource(source, deps);
      if (!r.ok) return r.error;
      try {
        const opts: { filePath: string; isVideo: boolean; videoStartTs?: number; fallback: boolean } = {
          filePath: r.resolved.path,
          isVideo,
          fallback,
        };
        if (videoStartTs !== undefined) opts.videoStartTs = videoStartTs;
        const { id } = await deps.telegram.setProfilePhoto(opts);
        return textResult(`Profile photo updated (photo id=${id})`);
      } finally {
        await r.resolved.cleanup();
      }
    },
  },
];
