/**
 * Pure parser for [rate-limiter] event lines emitted by @overpod/mcp-telegram.
 * Extracted from rate-limiter-events.ts so tests don't pull in the logger
 * (which transitively requires runtime ENV).
 */

export const PREFIX = "[rate-limiter] event ";

export type RateLimitEvent = {
  event: "flood_wait" | "network_retry" | "temporary_retry";
  context: string;
  attempt: number;
  maxRetries: number;
  seconds?: number;
  delayMs?: number;
  error?: string;
};

export function parseEvent(line: string): RateLimitEvent | null {
  const json = line.slice(PREFIX.length).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.event !== "string" ||
    typeof p.context !== "string" ||
    typeof p.attempt !== "number" ||
    typeof p.maxRetries !== "number"
  ) {
    return null;
  }
  if (p.event !== "flood_wait" && p.event !== "network_retry" && p.event !== "temporary_retry") {
    return null;
  }
  const result: RateLimitEvent = {
    event: p.event,
    context: p.context,
    attempt: p.attempt,
    maxRetries: p.maxRetries,
  };
  if (typeof p.seconds === "number") result.seconds = p.seconds;
  if (typeof p.delayMs === "number") result.delayMs = p.delayMs;
  if (typeof p.error === "string") result.error = p.error;
  return result;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
