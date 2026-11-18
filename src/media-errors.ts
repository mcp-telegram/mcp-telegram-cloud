import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isTelegramAuthError } from "./auth-errors.js";
import { logger } from "./logger.js";
import {
  type confirmSessionRevoked,
  UNCONFIRMED_REVOCATION_MESSAGE,
  UNCONFIRMED_REVOCATION_RETRY_MS,
} from "./session-confirm.js";
import { toolErrorText } from "./tool-error-text.js";
import { loggableToolError } from "./tool-registry.js";

/**
 * Machine-readable errors for the media tools and transfer routes. Every error text
 * starts with `[CODE]` or `[CODE retryable retryAfterMs=N]`, so an agent can tell a
 * call worth repeating from a final answer without parsing prose.
 */
export type MediaCode =
  | "DOWNLOAD_BUSY"
  | "TRANSFER_BUSY"
  | "TRANSFER_TOO_SLOW"
  | "MEDIA_TOO_LARGE"
  | "NO_MEDIA"
  | "MESSAGE_NOT_FOUND"
  | "MEDIA_NOT_DOWNLOADABLE"
  | "MEDIA_UNAVAILABLE"
  | "MEDIA_CHANGED"
  | "FILE_REFERENCE_EXPIRED"
  | "DOWNLOAD_NOT_FOUND"
  | "DOWNLOAD_FAILED"
  | "INVALID_RANGE"
  | "RATE_LIMITED"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_ACCOUNT_MISMATCH"
  | "UPLOAD_SIZE_MISMATCH"
  | "UPLOAD_HASH_MISMATCH"
  | "UPLOAD_FAILED"
  | "URL_FETCH_DENIED"
  | "ACCOUNT_UNAVAILABLE"
  | "SERVER_MISCONFIGURED"
  | "INVALID_INPUT"
  | "SEND_UNCONFIRMED"
  | "TELEGRAM_ERROR";

export class MediaError extends Error {
  readonly code: MediaCode;
  readonly retryAfterMs: number | undefined;
  constructor(code: MediaCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function mediaErrorText(code: string, message: string, retryAfterMs?: number): string {
  const tag = retryAfterMs !== undefined ? `[${code} retryable retryAfterMs=${retryAfterMs}]` : `[${code}]`;
  return `${tag} ${message}`;
}

export function mediaErrorResult(code: MediaCode, message: string, retryAfterMs?: number): CallToolResult {
  return { content: [{ type: "text", text: mediaErrorText(code, message, retryAfterMs) }], isError: true };
}

const CORE_CODES = new Set<string>([
  "MESSAGE_NOT_FOUND",
  "NO_MEDIA",
  "MEDIA_NOT_DOWNLOADABLE",
  "MEDIA_UNAVAILABLE",
  "FILE_REFERENCE_EXPIRED",
  "MEDIA_TOO_LARGE",
  "RATE_LIMITED",
  "DOWNLOAD_FAILED",
  "UPLOAD_SIZE_MISMATCH",
  "UPLOAD_FAILED",
  "INVALID_RANGE",
  "MEDIA_CHANGED",
]);

const FLOOD = /^Rate limit: Telegram requires (\d+)/;

/** Code, message and retry delay for any error a media tool or route can see. */
export function classifyMediaError(e: unknown): { code: string; message: string; retryAfterMs?: number } {
  if (e instanceof MediaError) {
    return { code: e.code, message: e.message, ...(e.retryAfterMs !== undefined && { retryAfterMs: e.retryAfterMs }) };
  }
  const err = e as { name?: unknown; code?: unknown; message?: unknown; retryable?: unknown; retryAfterMs?: unknown };
  const message = typeof err?.message === "string" ? err.message : String(e);
  // Core TelegramMediaError, matched by shape so a duplicated module instance still counts.
  if (err?.name === "TelegramMediaError" && typeof err.code === "string" && CORE_CODES.has(err.code)) {
    const retry = err.retryable === true ? (typeof err.retryAfterMs === "number" ? err.retryAfterMs : 3000) : undefined;
    return { code: err.code, message, ...(retry !== undefined && { retryAfterMs: retry }) };
  }
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return { code: "DOWNLOAD_FAILED", message: "Telegram did not answer in time.", retryAfterMs: 3000 };
  }
  const flood = FLOOD.exec(message);
  if (flood) return { code: "RATE_LIMITED", message, retryAfterMs: Number(flood[1]) * 1000 };
  if (/exceeds \d+ byte limit/.test(message)) return { code: "MEDIA_TOO_LARGE", message };
  return { code: "TELEGRAM_ERROR", message: toolErrorText(message).replace(/^Error: /, "") };
}

/** The auth error was not confirmed on the main connection: retry, keep the session. */
export function unconfirmedRevocation(): MediaError {
  return new MediaError("ACCOUNT_UNAVAILABLE", UNCONFIRMED_REVOCATION_MESSAGE, UNCONFIRMED_REVOCATION_RETRY_MS);
}

/**
 * What of an error text may be logged. A URL fetch denial quotes the user's URL, host or
 * redirect target (which can carry credentials or signed paths), so only its reason code
 * is kept; other texts go through {@link loggableToolError}.
 */
function loggedDetail(code: string, message: string): string {
  if (code === "URL_FETCH_DENIED") return /\(([a-z_]+)\)/.exec(message)?.[1] ?? "denied";
  return loggableToolError(message);
}

/**
 * `onError` for media tools: every failure gets a code. A Telegram auth error of the
 * call's own client returns null: the registry confirms it on the main connection (see
 * {@link confirmSessionRevoked}) before it revokes anything, as for every tool.
 */
export function mediaToolOnError(toolName: string): (e: unknown) => CallToolResult | null {
  return (e) => {
    // Errors of other accounts' clients never get here as auth errors (see onAccount).
    if (isTelegramAuthError(e)) return null;
    const { code, message, retryAfterMs } = classifyMediaError(e);
    const logged = `[${code}] ${loggedDetail(code, message)}`;
    logger.warn(`Tool error in ${toolName}: ${logged}`, {
      component: "tools",
      event: "tool.error",
      tool: toolName,
      error: logged,
    });
    return {
      content: [{ type: "text", text: mediaErrorText(code, message, retryAfterMs) }],
      isError: true,
    };
  };
}
