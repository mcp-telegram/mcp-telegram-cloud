/** Graceful-shutdown coordination.
 *
 * On SIGTERM the server enters a `draining` state:
 *   1. /health flips to 503 → Traefik health-check fails → load balancer
 *      stops routing new connections to this task.
 *   2. We hold for DRAIN_HEALTH_DELAY_MS so Traefik definitely noticed the
 *      flip (Traefik's default health-check interval is 30s — we use 10s
 *      here matching the Compose `healthcheck.interval: 10s` cadence).
 *   3. We poll in-flight MCP requests every 500ms and exit early once the
 *      count hits zero, OR after DRAIN_TIMEOUT_MS regardless.
 *
 * We wait for in-flight REQUESTS, not for open sessions. A Streamable HTTP
 * session outlives the request that created it and closes only when the client
 * disconnects or the idle reaper evicts it, so a connected-but-quiet client
 * keeps one open indefinitely. Waiting for sessions to reach zero therefore
 * burned the full timeout on every deploy — measured in production: four
 * consecutive restarts all ended in `drain timeout active=11` / `active=5` —
 * and then killed whatever was in flight anyway. Waiting for work to finish
 * both ends quickly and actually protects a tool call mid-execution; a client
 * whose session is cut simply reconnects and gets a new one.
 *   4. Caller (`server.tsx`) then proceeds with the existing
 *      `httpServer.stop()` + telemetry flush sequence.
 *
 * Why a separate module: the flag is read by both /health (in
 * `src/routes/static.tsx`) and the SIGTERM handler (in `src/server.tsx`);
 * keeping it as a module-level singleton with named accessors makes the
 * read-side trivially testable without touching either entry point.
 */

import { getActiveSessionsByClient, getInFlightMcpRequests } from "./mcp-handler.js";
import { CLIENT_CLASSES } from "./middleware/classify-client.js";
import { DRAIN_OUTCOME, incr } from "./telemetry/metrics.js";

let draining = false;

export function isDraining(): boolean {
  return draining;
}

/** Test-only reset — exposed so unit tests can run drain twice in one process. */
export function _resetDrainingFlagForTest(): void {
  draining = false;
}

export function getActiveMcpSessionsTotal(): number {
  let total = 0;
  for (const cls of CLIENT_CLASSES) {
    total += getActiveSessionsByClient(cls);
  }
  return total;
}

export interface DrainOptions {
  /** Wait this long after flipping /health to 503, so Traefik has time to
   *  notice the failed health-check and route new traffic elsewhere. */
  healthDelayMs: number;
  /** Hard cap on total drain time. After this, we stop waiting for active
   *  sessions and let the caller proceed with shutdown — clients still
   *  connected at that point will see a connection reset, same as today. */
  timeoutMs: number;
  /** Poll interval for active-session count during the wait phase. */
  pollMs: number;
  /** Optional logger hook (so tests can observe progress without spinning
   *  up the real logger / SigNoz writer). */
  onProgress?: (
    event: "start" | "health-delay-done" | "drained" | "timeout",
    inFlight: number,
    activeSessions: number,
  ) => void;
  /** In-flight work reader — what the drain actually waits for. Tests inject a
   *  mock to drive deterministic transitions. */
  inFlightRequests?: () => number;
  /** Open-session reader, reported in progress events for context only. Never
   *  gates the drain: see the module comment. */
  activeSessions?: () => number;
  /** Sleep primitive. Defaulted to setTimeout-Promise; tests inject fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the drain sequence. Resolves when either:
 *   - the active-session count reached zero (clean drain), or
 *   - `timeoutMs` elapsed (forced drain — clients still active will see a reset).
 *
 * Idempotent: calling twice is a no-op the second time (the flag never
 * flips back to `false` in production; tests reset via `_resetDrainingFlagForTest`).
 */
export async function startDrain(opts: DrainOptions): Promise<{ outcome: "drained" | "timeout"; remaining: number }> {
  const sleep = opts.sleep ?? defaultSleep;
  const readInFlight = opts.inFlightRequests ?? getInFlightMcpRequests;
  const readSessions = opts.activeSessions ?? getActiveMcpSessionsTotal;
  const onProgress = opts.onProgress;

  if (draining) {
    return { outcome: "drained", remaining: readInFlight() };
  }
  draining = true;
  onProgress?.("start", readInFlight(), readSessions());

  await sleep(opts.healthDelayMs);
  onProgress?.("health-delay-done", readInFlight(), readSessions());

  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const remaining = readInFlight();
    if (remaining === 0) {
      onProgress?.("drained", 0, readSessions());
      incr(DRAIN_OUTCOME, { outcome: "drained" });
      return { outcome: "drained", remaining: 0 };
    }
    await sleep(opts.pollMs);
  }

  const finalRemaining = readInFlight();
  onProgress?.("timeout", finalRemaining, readSessions());
  incr(DRAIN_OUTCOME, { outcome: "timeout" });
  return { outcome: "timeout", remaining: finalRemaining };
}
