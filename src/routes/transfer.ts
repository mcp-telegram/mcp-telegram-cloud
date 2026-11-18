import { createHash, type Hash } from "node:crypto";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import type { DownloadStore, Ticket } from "../download-store.js";
import { logger, logUser } from "../logger.js";
import { markWedged, onAccount, openTicketMedia, telegramForAccount } from "../media-access.js";
import { classifyMediaError, MediaError } from "../media-errors.js";
import { guardChunks, type Lease, leaseTransfer, mediaTimeouts, ThroughputGuard } from "../media-queue.js";
import { getClientIp, rateLimit } from "../rate-limit.js";
import type { SessionManager } from "../session-manager.js";
import type { UploadStore } from "../upload-store.js";

type Sessions = Pick<SessionManager, "listAccounts" | "getAccountAttachmentId" | "ensureAccountSession"> &
  Partial<Pick<SessionManager, "markUnhealthy" | "reportDeadSession">>;

/** Telegram's file cap plus slack: the server-wide body ceiling Bun enforces. */
export const MAX_REQUEST_BODY_BYTES = 2000 * 1024 * 1024 + 1024 * 1024;
/** Cap for every other route: JSON-RPC, OAuth forms and settings posts are small. */
const DEFAULT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
/** Multipart slack on top of the per-file cap of `/my/upload`. */
const UPLOAD_FORM_SLACK_BYTES = 1024 * 1024;
const UPLOAD_LINK_PATH = /^\/u\/[^/]+\/?$/;
const chunkedBodyLimit = bodyLimit({
  maxSize: DEFAULT_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

/**
 * Global request-body policy, applied before any route reads a body.
 *  - `/u/<token>`: passed through untouched; the route validates the token and the
 *    exact Content-Length first, then streams the body into Telegram unbuffered.
 *  - `/my/upload`: Content-Length required and checked against the per-file cap.
 *  - everything else: Content-Length checked from the header (nothing read); a body
 *    without one is buffered by Hono up to only {@link DEFAULT_BODY_LIMIT_BYTES}.
 */
export const requestBodyLimit: MiddlewareHandler = async (c, next) => {
  if (!c.req.raw.body || UPLOAD_LINK_PATH.test(c.req.path)) return next();
  const isUpload = c.req.path.replace(/\/$/, "") === "/my/upload";
  const max = isUpload ? config.uploadFileMaxBytes + UPLOAD_FORM_SLACK_BYTES : DEFAULT_BODY_LIMIT_BYTES;
  const declared = c.req.header("content-length");
  if (declared !== undefined && !c.req.raw.headers.has("transfer-encoding")) {
    return Number(declared) > max ? c.json({ error: "payload_too_large" }, 413) : next();
  }
  if (isUpload) return c.json({ error: "length_required", message: "Content-Length is required." }, 411);
  return chunkedBodyLimit(c, next);
};

const STATUS: Record<string, number> = {
  DOWNLOAD_NOT_FOUND: 404,
  UPLOAD_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 410,
  NO_MEDIA: 410,
  MEDIA_UNAVAILABLE: 410,
  MEDIA_CHANGED: 410,
  FILE_REFERENCE_EXPIRED: 410,
  MEDIA_NOT_DOWNLOADABLE: 422,
  TRANSFER_BUSY: 429,
  TRANSFER_TOO_SLOW: 408,
  RATE_LIMITED: 429,
  UPLOAD_SIZE_MISMATCH: 400,
  UPLOAD_HASH_MISMATCH: 400,
  INVALID_RANGE: 400,
  INVALID_INPUT: 400,
  MEDIA_TOO_LARGE: 413,
  ACCOUNT_UNAVAILABLE: 503,
};

/** JSON error with the same `code` the MCP tools use, plus Retry-After when retryable. */
export function transferError(c: Context, e: unknown): Response {
  const { code, message, retryAfterMs } = classifyMediaError(e);
  const status = STATUS[code] ?? 502;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterMs !== undefined) headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return c.json({ error: code, message, ...(retryAfterMs !== undefined && { retryAfterMs }) }, status as 400, headers);
}

/**
 * One `bytes=` range of a file of `size` bytes. Returns null when the header is absent,
 * malformed or asks for several ranges (served in full, as RFC 9110 allows), and
 * "unsatisfiable" for a range that starts past the end.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

function attachmentHeaders(fileName: string): Record<string, string> {
  // Never render arbitrary HTML/SVG/documents on the OAuth origin. Even an
  // adversarial MIME or filename is returned as an attachment, not executed.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    "Content-Disposition": `attachment; filename="media.bin"; filename*=UTF-8''${encoded}`,
    "Content-Type": "application/octet-stream",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
}

/** Response with the headers middleware already set on `c` plus `extra`. */
function respond(
  c: Context,
  body: ReadableStream<Uint8Array> | null,
  status: number,
  extra: Record<string, string>,
): Response {
  const headers = new Headers(c.res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { status, headers });
}

/** Largest piece handed to the HTTP client at once, so the throughput guard sees steady progress. */
const RESPONSE_SLICE_BYTES = 64 * 1024;

/**
 * Stream a ticket's file from Telegram to the HTTP client. File headers go out only
 * with the streaming response, after Telegram confirmed the file; error responses
 * carry their own JSON headers. Every Telegram call runs as a step of one queue lease
 * (see {@link Lease}): a client disconnect, a stalled call, a client that reads too
 * slowly (see {@link ThroughputGuard}) or the total time limit answers the client and
 * frees the slot once the call settles. Each piece re-checks the account binding
 * before it is sent. `held` is a slot the caller already took; it is used and ended here.
 */
export async function streamTicket(
  c: Context,
  ticket: Ticket,
  deps: { sessions: Sessions },
  via: "session" | "link",
  held?: Lease,
): Promise<Response> {
  const size = ticket.metadata.size;
  const range = parseRange(c.req.header("range"), size);
  if (range === "unsatisfiable") {
    held?.end();
    return respond(c, null, 416, { "Content-Range": `bytes */${size}`, "Cache-Control": "private, no-store" });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const status = range ? 206 : 200;
  const fileHeaders: Record<string, string> = {
    ...attachmentHeaders(ticket.metadata.fileName),
    "Content-Length": String(end - start + 1),
    ...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
  };
  if (c.req.method === "HEAD") {
    held?.end();
    return respond(c, null, status, fileHeaders);
  }

  let lease: Lease;
  try {
    lease = held ?? (await leaseTransfer(ticket.owner, getClientIp(c), { wait: false }));
  } catch (e) {
    return transferError(c, e);
  }
  try {
    return await streamWithLease(c, ticket, deps, via, lease, { start, end, status, fileHeaders });
  } catch (e) {
    // Nothing may hold the slot when the stream never started (ended is idempotent).
    lease.end();
    return transferError(c, e);
  }
}

async function streamWithLease(
  c: Context,
  ticket: Ticket,
  deps: { sessions: Sessions },
  via: "session" | "link",
  lease: Lease,
  {
    start,
    end,
    status,
    fileHeaders,
  }: { start: number; end: number; status: number; fileHeaders: Record<string, string> },
): Promise<Response> {
  const size = ticket.metadata.size;
  const clientSignal = c.req.raw.signal;
  const startedAt = Date.now();
  let sent = 0;
  let finished = false;
  let iterator: AsyncIterator<Buffer> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  // Ends the transfer from outside a pull(): a client that left or stopped reading leaves
  // no pending step that could notice the abort, so the slot would stay taken.
  const stop = (err: MediaError, outcome: string) => {
    lease.abort(err);
    finish(outcome);
    try {
      streamController?.error(err);
    } catch {
      // already closed or errored
    }
  };
  const onClientAbort = () => stop(new MediaError("DOWNLOAD_FAILED", "Client closed the connection."), "aborted");
  clientSignal?.addEventListener("abort", onClientAbort, { once: true });
  const total = setTimeout(
    () => stop(new MediaError("DOWNLOAD_FAILED", "Transfer time limit reached."), "timeout"),
    mediaTimeouts.totalMs,
  );
  const guard = new ThroughputGuard((err) => stop(err, "too-slow"));
  // A client that left before the listener was attached never fires it.
  if (clientSignal?.aborted) onClientAbort();
  function finish(outcome: string): void {
    if (finished) return;
    finished = true;
    clearTimeout(total);
    guard.stop();
    clientSignal?.removeEventListener("abort", onClientAbort);
    lease.end(() => {
      iterator?.return?.(undefined).catch(() => {});
    });
    if (outcome === "lookup-failed") return;
    logger.info(`Download stream ${outcome}`, {
      component: "downloads",
      event: "downloads.stream",
      userId: logUser(ticket.owner),
      source: via,
      outcome,
      bytes: sent,
      size,
      durationMs: Date.now() - startedAt,
    });
  }
  const assertBound = () => {
    // The account may be detached or replaced at any point of a long transfer.
    if (!ticket.canRead()) {
      throw new MediaError("ACCOUNT_UNAVAILABLE", "The Telegram account of this download is no longer attached.");
    }
  };

  let reader: Awaited<ReturnType<typeof openTicketMedia>>;
  /** The account's client, once connected; marked wedged if a step times out. */
  let client: TelegramService | undefined;
  const wedged = () => markWedged(deps.sessions, ticket.owner, client);
  try {
    reader = await lease.step(
      async (signal) => {
        const telegram = await telegramForAccount(
          deps.sessions,
          ticket.owner,
          ticket.accountId,
          ticket.canRead,
          config.telegramConnectTimeoutMs,
        );
        client = telegram;
        signal.throwIfAborted();
        return onAccount(deps.sessions, ticket.owner, telegram, () => openTicketMedia(telegram, ticket));
      },
      mediaTimeouts.lookupMs,
      "DOWNLOAD_FAILED",
      wedged,
    );
    assertBound();
  } catch (e) {
    finish("lookup-failed");
    return transferError(c, e);
  }

  const want = end - start + 1;
  const it = reader.stream(start, lease.signal)[Symbol.asyncIterator]();
  iterator = it;
  /** Rest of the last Telegram chunk, handed out in {@link RESPONSE_SLICE_BYTES} pieces. */
  let pending: Uint8Array | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      try {
        if (!pending) {
          guard.clientTurn(false);
          const next = await lease.step(
            () => (client ? onAccount(deps.sessions, ticket.owner, client, () => it.next()) : it.next()),
            mediaTimeouts.chunkMs,
            "DOWNLOAD_FAILED",
            wedged,
          );
          if (next.done) {
            if (sent < want) throw new MediaError("DOWNLOAD_FAILED", "Telegram ended the file early.", 3000);
            finish("ok");
            controller.close();
            return;
          }
          pending = sent + next.value.length > want ? next.value.subarray(0, want - sent) : next.value;
        }
        assertBound();
        const chunk = pending.subarray(0, RESPONSE_SLICE_BYTES);
        pending = pending.length > chunk.length ? pending.subarray(chunk.length) : undefined;
        sent += chunk.length;
        guard.count(chunk.length);
        controller.enqueue(chunk);
        guard.clientTurn(true);
        if (sent >= want) {
          finish("ok");
          controller.close();
        }
      } catch (e) {
        finish(lease.signal.aborted ? "aborted" : "error");
        controller.error(e);
      }
    },
    cancel() {
      lease.abort(new MediaError("DOWNLOAD_FAILED", "Client closed the connection."));
      finish("cancelled");
    },
  });
  return respond(c, body, status, fileHeaders);
}

/** Pass `source` through, feeding every chunk to `hash` when there is one. */
async function* hashing(source: AsyncIterable<Uint8Array>, hash: Hash | undefined): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    hash?.update(chunk);
    yield chunk;
  }
}

async function* readChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  // A trickling client may never finish a read: an abort cancels it instead of waiting.
  const onAbort = () => reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export interface TransferRoutesDeps {
  sessions: Sessions;
  downloads: DownloadStore;
  uploads: UploadStore;
}

/**
 * Capability links for agents without a browser sign-in. The 128-bit token in the
 * path is the only credential: single use, 5 minutes for a download link and 15 for an
 * upload link, bound to the owner and account it was made for. Tokens are stored hashed, so they never reach logs or
 * SQLite; the access log records paths, so keep tokens out of anything but the URL.
 */
export function createTransferRoutes(deps: TransferRoutesDeps): Hono {
  const app = new Hono({ strict: false });
  const linkRateLimit = rateLimit({
    limit: config.transferLinkRateLimit,
    windowMs: config.transferLinkRateWindowMs,
    scope: "transfer_link",
  });

  // Hono matches routes on the DECODED path, so `/%64/<token>` reaches `/d/:token` while
  // log masks keyed on the raw path miss it. Serve link routes only under their literal
  // prefix; any other spelling is not a link.
  const literalPrefix: MiddlewareHandler = async (c, next) => {
    const raw = new URL(c.req.url).pathname;
    if (!/^\/[du]\//.test(raw)) return c.json({ error: "not_found" }, 404, { "Cache-Control": "no-store" });
    return next();
  };
  app.use("/d/*", literalPrefix, linkRateLimit);
  app.use("/u/*", literalPrefix, linkRateLimit);

  // HEAD is refused: it must neither reveal the file without using the link up
  // nor let a link preview burn it. Agents use GET directly.
  app.get("/d/:token", async (c) => {
    // Hono serves HEAD through GET handlers, so refuse it here, before the token is touched.
    if (c.req.method === "HEAD") return c.body(null, 405, { Allow: "GET", "Cache-Control": "no-store" });
    const token = c.req.param("token");
    const notFound = () =>
      transferError(
        c,
        new MediaError(
          "DOWNLOAD_NOT_FOUND",
          "This download link is unknown, already used or expired (links work once, for 5 minutes). Ask the assistant for the file again to get a new link.",
        ),
      );
    const owner = deps.downloads.peek(token);
    if (!owner) return notFound();
    // Slot first, then use the link up: "server busy" must leave the link working.
    let lease: Lease;
    try {
      lease = await leaseTransfer(owner, getClientIp(c), { wait: false });
    } catch (e) {
      return transferError(c, e);
    }
    let ticket: Ticket | null;
    try {
      ticket = deps.downloads.redeem(token);
    } catch (e) {
      lease.end();
      throw e;
    }
    if (!ticket) {
      lease.end();
      return notFound();
    }
    return streamTicket(c, ticket, deps, "link", lease);
  });

  app.on(["PUT", "POST"], "/u/:token", async (c) => {
    const token = c.req.param("token");
    const link = deps.uploads.peekLink(token);
    if (!link) {
      return transferError(
        c,
        new MediaError(
          "UPLOAD_NOT_FOUND",
          "This upload link is unknown, already used or expired. A link works for one request only; create a new one with telegram-create-upload-link.",
        ),
      );
    }
    const declared = c.req.header("content-length");
    // Any request that presents the token uses it up, valid or not, so a token that
    // shows up in some log can't be replayed. Only "server busy" leaves it alive.
    if (declared === undefined) {
      deps.uploads.claimLink(token);
      return c.json(
        {
          error: "UPLOAD_SIZE_MISMATCH",
          message: "Content-Length is required. Use curl -T <file> '<url>', which sets it from the file size.",
        },
        411,
      );
    }
    if (!/^\d+$/.test(declared) || Number(declared) !== link.size) {
      deps.uploads.claimLink(token);
      return transferError(
        c,
        new MediaError(
          "UPLOAD_SIZE_MISMATCH",
          `Content-Length ${declared} does not match the size declared for this link (${link.size}). Create a new link with the exact size.`,
        ),
      );
    }
    let lease: Lease;
    try {
      lease = await leaseTransfer(link.owner, getClientIp(c), { wait: false });
    } catch (e) {
      return transferError(c, e);
    }
    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => lease.abort(new MediaError("UPLOAD_FAILED", "Client closed the connection."));
    clientSignal?.addEventListener("abort", onClientAbort, { once: true });
    if (clientSignal?.aborted) onClientAbort();
    const startedAt = Date.now();
    const guard = new ThroughputGuard((err) => lease.abort(err));
    try {
      // Claim only after a slot was granted, so "server busy" doesn't burn the link.
      const claimed = deps.uploads.claimLink(token);
      if (!claimed) {
        throw new MediaError(
          "UPLOAD_NOT_FOUND",
          "This upload link was already used or expired. Create a new one with telegram-create-upload-link.",
        );
      }
      const hash = claimed.sha256 ? createHash("sha256") : undefined;
      // Connect and upload as one bounded step: the deadline answers the request even
      // when a body read or Telegram call never notices the abort.
      let client: TelegramService | undefined;
      const file = await lease.step(
        async (signal) => {
          const telegram = await telegramForAccount(
            deps.sessions,
            claimed.owner,
            claimed.accountId,
            claimed.canUse,
            config.telegramConnectTimeoutMs,
          );
          client = telegram;
          const body = c.req.raw.body;
          if (!body) throw new MediaError("UPLOAD_SIZE_MISMATCH", "The request has no body.");
          const chunks = guardChunks(hashing(readChunks(body, signal), hash), guard);
          return onAccount(deps.sessions, claimed.owner, telegram, () =>
            telegram.uploadStream(chunks, claimed.size, claimed.fileName, signal),
          );
        },
        mediaTimeouts.totalMs,
        "UPLOAD_FAILED",
        () => markWedged(deps.sessions, claimed.owner, client),
      );
      // The bytes must be the ones the link was made for; otherwise nothing is stored.
      if (hash && hash.digest("hex") !== claimed.sha256) {
        throw new MediaError(
          "UPLOAD_HASH_MISMATCH",
          "The uploaded bytes do not match the sha256 given for this link, so nothing was stored. Create a new link.",
        );
      }
      // The handle is only usable by the account that uploaded it.
      if (!claimed.canUse()) {
        throw new MediaError("ACCOUNT_UNAVAILABLE", "The Telegram account of this upload link is no longer attached.");
      }
      const stored = deps.uploads.put(
        claimed.owner,
        { accountId: claimed.accountId, canUse: claimed.canUse },
        file,
        file.mimeType ?? "application/octet-stream",
        claimed.fileName,
        claimed.uploadId,
      );
      logger.info(`Upload link used: ${claimed.uploadId}`, {
        component: "uploads",
        event: "uploads.stored",
        source: "link",
        userId: logUser(claimed.owner),
        uploadId: claimed.uploadId,
        size: claimed.size,
        durationMs: Date.now() - startedAt,
      });
      return c.json({
        uploadId: stored.id,
        fileName: claimed.fileName,
        size: claimed.size,
        expiresAt: stored.expiresAt.toISOString(),
        next: "Pass uploadId as source { kind: 'upload', uploadId } to a telegram-send-* tool.",
      });
    } catch (e) {
      logger.warn(`Upload link failed: ${classifyMediaError(e).code}`, {
        component: "uploads",
        event: "uploads.denied",
        source: "link",
        userId: logUser(link.owner),
        reason: classifyMediaError(e).code,
        durationMs: Date.now() - startedAt,
      });
      return transferError(c, e);
    } finally {
      guard.stop();
      clientSignal?.removeEventListener("abort", onClientAbort);
      lease.end();
    }
  });

  return app;
}
