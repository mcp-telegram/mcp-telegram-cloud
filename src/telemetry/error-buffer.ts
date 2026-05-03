/**
 * In-memory ring buffer of recent ERROR-severity log records.
 *
 * Surface: powers `/api/observability` so a self-hoster can debug recent
 * failures without standing up SigNoz. Lost on process restart by design —
 * persistence would need a separate store and isn't worth the complexity at
 * current scale.
 *
 * Privacy: stores whatever the caller passed to `logger.error(...)`. PII
 * scrubbing is the caller's responsibility — `scripts/check-telemetry.ts`
 * grep-checks call sites for blacklisted identifiers.
 *
 * Concurrency: single-process Node, no locks needed.
 */

const CAPACITY = 500;

export interface ErrorEntry {
  /** ISO 8601 timestamp at capture time. */
  timestamp: string;
  message: string;
  /** Caller-provided attrs, stringified (numbers → strings, undefined dropped). */
  attrs: Record<string, string>;
}

const ring: ErrorEntry[] = [];

export function recordError(message: string, attrs: Record<string, string | number | undefined> = {}): void {
  const stringified: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    stringified[k] = String(v);
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
