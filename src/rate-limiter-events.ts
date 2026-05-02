/**
 * Captures structured retry events emitted by @overpod/mcp-telegram's
 * rate-limiter and forwards them to the cloud logger so SigNoz can aggregate
 * by `event` and `context`.
 *
 * Why monkey-patch console.error: TelegramService is consumed in-process and
 * doesn't expose the RateLimiter for dependency injection. The rate-limiter
 * deliberately writes a single-line stderr contract:
 *   [rate-limiter] event {"event":"...","context":"...",...}
 * which we parse here.
 *
 * Composition: this wrapper ALWAYS delegates to the previously-installed
 * console.error after logging, including for matched rate-limiter lines.
 * That means:
 *   - Earlier interceptors (Sentry, Datadog, etc.) still see every line.
 *   - Lines remain visible in `docker logs` for human inspection.
 *   - Installation order doesn't change correctness, only whether OUR
 *     wrapper sits closer to the source than another wrapper.
 * The cost is one stderr line per event also being captured by other
 * interceptors. With ~zero FLOOD_WAIT/network errors in steady state
 * this is negligible.
 *
 * Available since @overpod/mcp-telegram >= 1.35.0; older versions emit
 * human-readable strings that simply pass through, so this is a no-op until
 * the dependency is bumped.
 */

import { logger } from "./logger.js";
import { PREFIX, parseEvent, truncate } from "./rate-limiter-events-parser.js";

let installed = false;

export function installRateLimiterEventListener(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);

  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith(PREFIX)) {
      // Wrap in try/catch so a malformed upstream line never breaks console.error
      // for the rest of the process.
      try {
        const parsed = parseEvent(first);
        if (parsed) {
          logger.warn(`rate-limiter ${parsed.event}`, {
            component: "rate-limiter",
            event: parsed.event,
            context: truncate(parsed.context, 200),
            attempt: parsed.attempt,
            maxRetries: parsed.maxRetries,
            ...(parsed.seconds !== undefined ? { seconds: parsed.seconds } : {}),
            ...(parsed.delayMs !== undefined ? { delayMs: parsed.delayMs } : {}),
            ...(parsed.error ? { error: truncate(parsed.error, 200) } : {}),
          });
        }
      } catch {
        // ignore — never let a logging failure swallow the upstream line
      }
    }
    // Always delegate so earlier interceptors (and docker logs) see every line.
    originalError(...args);
  };
}
