import type { TelegramService, UploadedFile } from "@overpod/mcp-telegram/service";
import { z } from "zod";
import { config as appConfig } from "../config.js";
import { UPLOAD_MAX_BYTES } from "../download-store.js";
import { fileNameFromUrl, sanitizeFileName } from "../filename.js";
import { accountBinding, markWedged, requireMediaCore } from "../media-access.js";
import { MediaError, mediaErrorResult, mediaToolOnError } from "../media-errors.js";
import {
  bufferedBodyDeadline,
  bufferQueue,
  CallBudget,
  guardChunks,
  StepTimeoutError,
  sendQueue,
  ThroughputGuard,
  transferQueue,
} from "../media-queue.js";
import type { ToolDefinition, ToolDeps } from "../tool-registry.js";
import { UrlFetchError } from "../url-fetcher.js";
import { CONFIRMED_WRITE_PUBLIC, LOCAL_WRITE, replyTargetFields, safeOpt, sanitize, textResult } from "./helpers.js";

/**
 * Media tools backed by uploads or HTTPS URLs.
 *
 * All 6 send tools share a `source` field:
 *   { kind: "upload", uploadId: "upl_..." }   — a file already streamed into Telegram
 *                                               (dashboard, POST /my/upload or an upload link)
 *   { kind: "url",    url: "https://..." }     — fetched with SSRF protection and streamed
 *                                               straight into Telegram
 * Either way the bytes never land on this server's disk; the tools pass Telegram's
 * uploaded-file handle to core instead of a path.
 */

const sourceSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upload"),
      uploadId: z
        .string()
        .min(1)
        .describe(
          "Upload ID (e.g. 'upl_a8f3...'). User-scoped, single-use, expires in ~15min. " +
            "To send a LOCAL file: call telegram-create-upload-link with its name and exact size, run the returned " +
            "curl -T <file> '<url>' command, then pass the returned uploadId here. " +
            "IDs from the dashboard or POST /my/upload (OAuth Bearer token, multipart field 'file') work too.",
        ),
    }),
    z.object({
      kind: z.literal("url"),
      url: z
        .string()
        .url()
        .describe(
          "HTTPS URL the cloud fetches with SSRF protection and streams into Telegram. Private/loopback addresses are rejected. Up to 2000 MiB when the server sends Content-Length, else ~50MB.",
        ),
    }),
  ])
  .describe(
    "Where to get the file bytes: an upload ID (see telegram-create-upload-link) or an https:// URL the cloud fetches. " +
      "Local filesystem paths are NOT accepted — upload the bytes first.",
  );

type SourceArg = z.infer<typeof sourceSchema>;

interface ResolvedSource {
  /** Telegram's handle for the uploaded bytes; its name decides the MIME type. */
  file: UploadedFile;
  /** Call after the send finishes (success or failure). */
  cleanup: () => void;
}

const SENT_CHECK = "Confirm delivery with telegram-read-messages if it matters.";

/** Bytes of a URL source pass straight from the HTTP response into Telegram. */
async function uploadFromUrl(
  telegram: TelegramService,
  openUrl: NonNullable<ToolDeps["openUrl"]>,
  url: string,
  userId: string,
  budget: CallBudget,
  onTimeout: () => void,
): Promise<UploadedFile> {
  // Fetch and upload are one bounded step of a transfer slot: the deadline answers the
  // tool call and the abort closes the HTTP response, so a hung body can't pin the slot.
  const lease = await transferQueue.lease(userId);
  let releaseBuffer: (() => void) | undefined;
  try {
    // A call budget is read after the slot is granted: time spent queueing counts too.
    const timeoutMs = budget.take();
    return await lease.step(
      async (signal) => {
        const opened = await openUrl(url, { maxBytes: UPLOAD_MAX_BYTES });
        if (!opened.ok)
          throw new MediaError("URL_FETCH_DENIED", `URL fetch denied (${opened.reason}): ${opened.message}`);
        const name = fileNameFromUrl(url) ?? "file";
        // A remote server that trickles its body is cut off like a slow HTTP client: the
        // lease aborts at once, so the caller hears TRANSFER_TOO_SLOW even while a part
        // already sent to Telegram is still pending.
        const guard = new ThroughputGuard((err) => {
          lease.abort(err);
          opened.cancel();
        });
        const body = guardChunks(opened.body, guard);
        const onAbort = () => opened.cancel();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          signal.throwIfAborted();
          if (opened.size !== undefined) {
            if (opened.size === 0) throw new MediaError("URL_FETCH_DENIED", "URL fetch denied: the response is empty.");
            return await telegram.uploadStream(body, opened.size, name, signal);
          }
          // No trustworthy length (chunked or compressed): Telegram needs the size up front,
          // so buffer in memory up to the dashboard upload cap, in a slot of the small pool
          // for buffered transfers. Still nothing on disk.
          const release = await bufferQueue.acquire(userId);
          releaseBuffer = release;
          // The call may have been answered while this waited for the slot.
          if (signal.aborted) {
            release();
            throw signal.reason;
          }
          const parts: Array<Uint8Array | undefined> = [];
          let total = 0;
          // The whole body must arrive within bufferedBodyMs, so buffer slots keep turning over.
          const bodyArrived = bufferedBodyDeadline(lease);
          try {
            for await (const chunk of body) {
              signal.throwIfAborted();
              total += chunk.byteLength;
              if (total > appConfig.uploadFileMaxBytes) {
                throw new MediaError(
                  "URL_FETCH_DENIED",
                  `URL fetch denied (too_large): the server sent no Content-Length and the body exceeds ${appConfig.uploadFileMaxBytes} bytes.`,
                );
              }
              parts.push(chunk);
            }
          } finally {
            bodyArrived();
          }
          if (total === 0) throw new MediaError("URL_FETCH_DENIED", "URL fetch denied: the response is empty.");
          guard.stop();
          // Hand the parts over one by one and forget each: no joined copy, and memory
          // shrinks as Telegram takes the file. The parts are ours, so core needn't copy them.
          return await telegram.uploadStream(drain(parts), total, name, signal, { ownsChunks: true });
        } catch (e) {
          if (e instanceof UrlFetchError)
            throw new MediaError("URL_FETCH_DENIED", `URL fetch denied (${e.reason}): ${e.message}`);
          throw e;
        } finally {
          guard.stop();
          signal.removeEventListener("abort", onAbort);
          opened.cancel();
          // Normal end of the work; lease.end below covers a step that never settles.
          releaseBuffer?.();
        }
      },
      timeoutMs,
      "UPLOAD_FAILED",
      onTimeout,
    );
  } finally {
    // Both slots go when the work settles, or at the backstop if it never does.
    lease.end(() => releaseBuffer?.());
  }
}

/** Yield `parts` in order, dropping each reference as it is handed out. */
async function* drain(parts: Array<Uint8Array | undefined>): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as Uint8Array;
    parts[i] = undefined;
    yield part;
  }
}

/**
 * Send through a slot of the send pool and the call's deadline. The account binding is checked
 * right before the call, so nothing goes out through a detached or replaced account.
 * After the call starts its outcome is reported as is: a deadline says the message may
 * still arrive, so an agent checks the chat instead of sending a duplicate.
 */
async function sendBounded<T>(deps: ToolDeps, budget: CallBudget, send: () => Promise<T>): Promise<T> {
  const userId = deps.userId ?? "";
  const binding = deps.sessions
    ? accountBinding(deps.sessions, userId, deps.sourceAccountId, deps.sourceAttachmentId)
    : undefined;
  try {
    return await sendQueue.runWithDeadline(
      userId,
      async () => {
        if (binding && !binding.canRead()) {
          throw new MediaError(
            "ACCOUNT_UNAVAILABLE",
            "The Telegram account changed before sending; nothing was sent. Reconnect and try again.",
          );
        }
        return send();
      },
      budget,
      "UPLOAD_FAILED",
      () => markWedged(deps.sessions, userId, deps.telegram),
    );
  } catch (e) {
    if (e instanceof StepTimeoutError) {
      throw new MediaError(
        "SEND_UNCONFIRMED",
        "Telegram did not confirm the send in time. It may still arrive: check the chat history (telegram-read-messages) before sending again.",
      );
    }
    throw e;
  }
}

/**
 * Resolve a source into Telegram's uploaded-file handle, or a coded error result.
 *
 * Uploads are bound to the account that uploaded them (Telegram keeps uploaded parts
 * per session), so an upload made with another account is refused, not silently lost.
 * Cleanup consumes the upload id: a failed send does not keep it for a retry.
 */
async function resolveSource(
  source: SourceArg,
  deps: ToolDeps,
  budget: CallBudget,
): Promise<{ ok: true; resolved: ResolvedSource } | { ok: false; error: ReturnType<typeof mediaErrorResult> }> {
  if (!deps.uploads || !deps.openUrl) {
    return {
      ok: false,
      error: mediaErrorResult(
        "SERVER_MISCONFIGURED",
        "Upload tools require server config (uploads + URL fetcher). This is a deploy bug; report it to the operator.",
      ),
    };
  }
  if (!deps.userId) {
    return {
      ok: false,
      error: mediaErrorResult(
        "SERVER_MISCONFIGURED",
        "Upload tools require an authenticated user context (cookie or OAuth bearer).",
      ),
    };
  }
  requireMediaCore(deps.telegram);

  if (source.kind === "upload") {
    const uploads = deps.uploads;
    const userId = deps.userId;
    const found = uploads.resolve(userId, source.uploadId);
    if (!found) {
      const waiting = uploads.isAwaitingLink(userId, source.uploadId);
      return {
        ok: false,
        error: mediaErrorResult(
          "UPLOAD_NOT_FOUND",
          waiting
            ? "The upload link for this ID has not been used yet. Run the curl -T command first, then retry."
            : "Upload not found. The ID is wrong, expired (15min TTL), already used, or belongs to another account. Upload again.",
        ),
      };
    }
    if (found.accountId !== deps.sourceAccountId) {
      return {
        ok: false,
        error: mediaErrorResult(
          "UPLOAD_ACCOUNT_MISMATCH",
          "This file was uploaded with a different Telegram account than the active one. Switch back to that account or upload again.",
        ),
      };
    }
    const uploadId = source.uploadId;
    return { ok: true, resolved: { file: found.file, cleanup: () => void uploads.consume(userId, uploadId) } };
  }

  const userId = deps.userId;
  const file = await uploadFromUrl(deps.telegram, deps.openUrl, source.url, userId, budget, () =>
    markWedged(deps.sessions, userId, deps.telegram),
  );
  // The handle only works for the account that uploaded it; it may have been detached meanwhile.
  if (
    deps.sessions &&
    !accountBinding(deps.sessions, deps.userId, deps.sourceAccountId, deps.sourceAttachmentId).canRead()
  ) {
    return {
      ok: false,
      error: mediaErrorResult(
        "ACCOUNT_UNAVAILABLE",
        "The Telegram account changed while the file was uploaded. Reconnect and try again.",
      ),
    };
  }
  return { ok: true, resolved: { file, cleanup: () => {} } };
}

const parseModeField = z.enum(["md", "html"]).optional().describe("Caption parse mode: 'md' (Markdown) or 'html'");

const captionField = z.string().optional().describe("Optional caption (truncated client-side as needed)");

export const UPLOAD_TOOLS: ToolDefinition[] = [
  {
    name: "telegram-send-file",
    description:
      "Send a file to a chat as a document. Bytes come from an uploadId (for a local file: telegram-create-upload-link, then curl -T) " +
      "or an https:// URL the cloud fetches (SSRF-protected). The recipient sees the original upload filename (or the last URL path segment), " +
      "which also decides the file type shown. Up to Telegram's 2000 MiB limit. After sending, confirm delivery via the chat history " +
      "(telegram-read-messages). Errors start with a code, e.g. [UPLOAD_NOT_FOUND].",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      source: sourceSchema,
      caption: captionField,
    },
    annotations: CONFIRMED_WRITE_PUBLIC,
    onError: mediaToolOnError("telegram-send-file"),
    handler: async ({ chatId, source, caption }, deps) => {
      // One time budget for the whole call: the upload of a URL source and the send.
      const budget = new CallBudget();
      const r = await resolveSource(source, deps, budget);
      if (!r.ok) return r.error;
      try {
        const fileName = r.resolved.file.fileName;
        await sendBounded(deps, budget, () => deps.telegram.sendFile(chatId, r.resolved.file, safeOpt(caption)));
        // Echo the name back: the only way the caller can tell that the document
        // arrived as `report.md` and not as a nameless octet-stream blob.
        return textResult(`Sent file "${fileName}" to ${chatId}. ${SENT_CHECK}`);
      } finally {
        r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-send-voice",
    description:
      "Send a voice message. Only OGG/Opus audio arrives as a voice message; other formats arrive as a regular audio file. Bytes from uploadId (local file: telegram-create-upload-link) or https:// URL. Confirm delivery via the chat history.",
    inputSchema: {
      chatId: z.string().describe("Chat ID or username"),
      source: sourceSchema,
      caption: captionField,
      parseMode: parseModeField,
      ...replyTargetFields,
    },
    annotations: CONFIRMED_WRITE_PUBLIC,
    onError: mediaToolOnError("telegram-send-voice"),
    handler: async ({ chatId, source, caption, parseMode, replyTo, topicId }, deps) => {
      // One time budget for the whole call: the upload of a URL source and the send.
      const budget = new CallBudget();
      const r = await resolveSource(source, deps, budget);
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
        // The upload's name (or sniffed bytes) drives codec detection upstream.
        const { id } = await sendBounded(deps, budget, () => deps.telegram.sendVoice(chatId, r.resolved.file, opts));
        return textResult(`Sent voice to ${chatId} (msg #${id})`);
      } finally {
        r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-send-video-note",
    description:
      "Send a round video note (MP4, square source for best look). Bytes from uploadId (local file: telegram-create-upload-link) or https:// URL. Confirm via the chat history that it arrived as a round video.",
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
    annotations: CONFIRMED_WRITE_PUBLIC,
    onError: mediaToolOnError("telegram-send-video-note"),
    handler: async ({ chatId, source, duration, length, replyTo, topicId }, deps) => {
      // One time budget for the whole call: the upload of a URL source and the send.
      const budget = new CallBudget();
      const r = await resolveSource(source, deps, budget);
      if (!r.ok) return r.error;
      try {
        const opts: { duration?: number; length?: number; replyTo?: number; topicId?: number } = {};
        if (duration !== undefined) opts.duration = duration;
        if (length !== undefined) opts.length = length;
        if (replyTo !== undefined) opts.replyTo = replyTo;
        if (topicId !== undefined) opts.topicId = topicId;
        const { id } = await sendBounded(deps, budget, () =>
          deps.telegram.sendVideoNote(chatId, r.resolved.file, opts),
        );
        return textResult(`Sent video note to ${chatId} (msg #${id})`);
      } finally {
        r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-send-album",
    description:
      "Send 2-10 files to a chat as one grouped album message. Each item supplies its own bytes (uploadId or https:// URL) and optional caption. Items arrive as files (documents), not as compressed photos. Confirm delivery via the chat history.",
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
        .describe("2-10 album items (Telegram cap; 1 item is invalid, a single file goes through telegram-send-file)"),
      caption: captionField,
      parseMode: parseModeField,
      ...replyTargetFields,
    },
    annotations: CONFIRMED_WRITE_PUBLIC,
    onError: mediaToolOnError("telegram-send-album"),
    handler: async ({ chatId, items, caption, parseMode, replyTo, topicId }, deps) => {
      // One time budget for the whole call: every item's URL upload and the send.
      const budget = new CallBudget();
      const resolved: ResolvedSource[] = [];
      try {
        for (const item of items) {
          const r = await resolveSource(item.source, deps, budget);
          // Already-resolved items are cleaned up by the `finally` below — no
          // explicit rollback loop needed (cleanup is idempotent either way).
          if (!r.ok) return r.error;
          resolved.push(r.resolved);
        }
        const upstreamItems = resolved.map((res, i) => {
          const itemCaption = items[i]?.caption;
          return {
            filePath: res.file,
            ...(itemCaption !== undefined ? { caption: sanitize(itemCaption) } : {}),
          };
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
        const { ids } = await sendBounded(deps, budget, () => deps.telegram.sendAlbum(chatId, upstreamItems, opts));
        return textResult(`Sent album of ${ids.length} to ${chatId} (msgs #${ids.join(",")})`);
      } finally {
        for (const r of resolved) r.cleanup();
      }
    },
  },

  {
    name: "telegram-send-story",
    description:
      "Post a story to your profile or a channel. Bytes from uploadId (local file: telegram-create-upload-link) or https:// URL. Caller picks privacy explicitly.",
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
    annotations: CONFIRMED_WRITE_PUBLIC,
    onError: mediaToolOnError("telegram-send-story"),
    preValidate: ({ privacy, allowUserIds }) => {
      // Mirror upstream guard (account.js:193-195): privacy='selected' without
      // a non-empty allowUserIds is rejected at the wire; surface it pre-handler.
      if (privacy === "selected" && (!allowUserIds || allowUserIds.length === 0)) {
        return mediaErrorResult("INVALID_INPUT", "privacy='selected' requires at least one user ID in allowUserIds.");
      }
      return null;
    },
    handler: async (
      { chatId, source, type, caption, parseMode, privacy, allowUserIds, disallowUserIds, period, pinned, noforwards },
      deps,
    ) => {
      // One time budget for the whole call: the upload of a URL source and the send.
      const budget = new CallBudget();
      const r = await resolveSource(source, deps, budget);
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
        const { id, period: actualPeriod } = await sendBounded(deps, budget, () =>
          deps.telegram.sendStory(chatId, r.resolved.file, opts),
        );
        return textResult(`Sent story to ${chatId} (id=${id ?? "?"}, period=${actualPeriod}s)`);
      } finally {
        r.resolved.cleanup();
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
    annotations: CONFIRMED_WRITE_PUBLIC,
    onError: mediaToolOnError("telegram-set-profile-photo"),
    handler: async ({ source, isVideo, videoStartTs, fallback }, deps) => {
      // One time budget for the whole call: the upload of a URL source and the send.
      const budget = new CallBudget();
      const r = await resolveSource(source, deps, budget);
      if (!r.ok) return r.error;
      try {
        const opts: { filePath: UploadedFile; isVideo: boolean; videoStartTs?: number; fallback: boolean } = {
          filePath: r.resolved.file,
          isVideo,
          fallback,
        };
        if (videoStartTs !== undefined) opts.videoStartTs = videoStartTs;
        const { id } = await sendBounded(deps, budget, () => deps.telegram.setProfilePhoto(opts));
        return textResult(`Profile photo updated (photo id=${id})`);
      } finally {
        r.resolved.cleanup();
      }
    },
  },

  {
    name: "telegram-create-upload-link",
    description:
      "Get a one-time link for uploading a LOCAL file, for agents that can run a shell command but have no browser sign-in. " +
      "Pass the file's name and exact size in bytes (up to Telegram's 2000 MiB limit). Then run the returned curl command " +
      "(curl -T <file> '<url>', i.e. HTTP PUT of the raw bytes; POST with a raw body also works). No token or header is needed: " +
      "the link itself authorizes one upload for this account and expires in 5 minutes, so run the command right away. The server streams the bytes into Telegram " +
      "and keeps no copy. When curl reports success, pass uploadId as source { kind: 'upload', uploadId } to a send tool. " +
      "The declared size must match the file exactly, otherwise the upload is refused and you need a new link. " +
      "Optionally pass sha256 (hex, e.g. from sha256sum): then only those exact bytes are accepted, so nobody else who sees the link can use it for other content.",
    inputSchema: {
      fileName: z
        .string()
        .min(1)
        .max(255)
        .describe("File name the recipient will see, with extension (e.g. 'report.pdf'); it decides the file type"),
      size: z
        .number()
        .int()
        .positive()
        .max(UPLOAD_MAX_BYTES)
        .describe("Exact file size in bytes (e.g. from `stat` or `wc -c`)"),
      sha256: z
        .string()
        .regex(/^[A-Fa-f0-9]{64}$/, "must be 64 hex characters")
        .optional()
        .describe(
          "Optional SHA-256 of the file in hex (sha256sum <file>). When given, an upload with other bytes is refused and nothing is stored.",
        ),
    },
    annotations: LOCAL_WRITE,
    skipRequireConnection: true,
    onError: mediaToolOnError("telegram-create-upload-link"),
    handler: async (
      { fileName, size, sha256 },
      { uploads, userId, sessions, baseUrl, sourceAccountId, sourceAttachmentId },
    ) => {
      if (!uploads || !userId || !sessions || !baseUrl) {
        throw new MediaError("SERVER_MISCONFIGURED", "Upload links are unavailable on this server.");
      }
      const name = sanitizeFileName(fileName);
      if (!name) throw new MediaError("INVALID_INPUT", "fileName has no usable characters.");
      const { accountId, canRead } = accountBinding(sessions, userId, sourceAccountId, sourceAttachmentId);
      const link = uploads.createLink(userId, { accountId, canUse: canRead }, name, size, sha256 ? { sha256 } : {});
      if ("error" in link) throw new MediaError("TRANSFER_BUSY", link.error, 60_000);
      const url = `${baseUrl}/u/${link.token}`;
      const result = {
        uploadId: link.uploadId,
        url,
        method: "PUT",
        fileName: name,
        size,
        ...(sha256 && { sha256: sha256.toLowerCase() }),
        expiresAt: link.expiresAt.toISOString(),
        // The command never echoes the supplied name: the placeholder stands for the local path.
        curl: `curl -fsS -T '<path to the local file>' '${url}'`,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  },
];
