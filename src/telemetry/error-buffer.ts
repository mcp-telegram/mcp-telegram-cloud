/**
 * In-memory ring buffer of recent ERROR-severity log records.
 *
 * Surface: powers `/api/observability` so a self-hoster can debug recent
 * failures without standing up SigNoz. Lost on process restart by design —
 * persistence would need a separate store and isn't worth the complexity at
 * current scale.
 *
 * Privacy: callers pass `LogFields` (compile-time whitelist of attribute
 * keys). The runtime grep guard in `scripts/check-telemetry.ts` is the
 * second layer that catches blacklisted keys behind escape hatches.
 *
 * Concurrency: single-process Node, no locks needed.
 */

import { type LogFields, MAX_ATTR_VALUE_LEN } from "./log-fields.js";

const CAPACITY = 500;

export interface ErrorEntry {
  /** ISO 8601 timestamp at capture time. */
  timestamp: string;
  message: string;
  /** Caller-provided attrs, stringified (numbers → strings, undefined dropped). */
  attrs: Record<string, string>;
}

const ring: ErrorEntry[] = [];

export function recordError(message: string, attrs: LogFields = {}): void {
  const stringified: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    const s = String(v);
    stringified[k] = s.length > MAX_ATTR_VALUE_LEN ? `${s.slice(0, MAX_ATTR_VALUE_LEN)}…` : s;
  }
  ring.push({
    timestamp: new Date().toISOString(),
    message,
    attrs: stringified,
  });
  if (ring.length > CAPACITY) ring.shift();
}

/** Returns most-recent-first up to `limit` entries (default = capacity). */
export function getRecentErrors(limit = CAPACITY): ErrorEntry[] {
  const slice = limit >= ring.length ? ring : ring.slice(ring.length - limit);
  return [...slice].reverse();
}

/** Test-only: drain the buffer between assertions. */
export function _resetErrorBuffer(): void {
  ring.length = 0;
}

export const ERROR_BUFFER_CAPACITY = CAPACITY;
