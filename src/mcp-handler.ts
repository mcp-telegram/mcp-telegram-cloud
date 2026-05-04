import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { config, iconPng256Url, iconPngUrl, iconUrl } from "./config.js";
import { type DestructiveGuard, summarizeArgs } from "./destructive-guard.js";
import { logger, logUser } from "./logger.js";
import { CLIENT_CLASSES, type ClientClass, classifyClient } from "./middleware/classify-client.js";
import type { OAuthProvider } from "./oauth.js";
import type { SessionManager } from "./session-manager.js";
import { incr, RATE_LIMIT_HITS } from "./telemetry/metrics.js";
import { registerAllAllowedTools } from "./tools.js";
import type { UploadStore } from "./upload-store.js";
import { fetchUrlSafely } from "./url-fetcher.js";
import type { UsageTracker } from "./usage.js";

/** Map of MCP session ID → transport (for multi-request sessions) */
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

/** Map of MCP session ID → userId (to track which user owns which session) */
const sessionOwners = new Map<string, string>();

/** Count of active MCP sessions per userId */
const activeSessionCount = new Map<string, number>();

/**
 * Last-activity timestamp (epoch ms) per session id. Bumped on every
 * `handleMcpRequest` hit (init + every session-reuse) so the reaper can
 * tell live-but-idle from abandoned. Stored alongside `transports` rather
 * than inside it so the reaper can iterate without disturbing the existing
 * Map shape used by the SDK plumbing.
 */
const lastActivity = new Map<string, number>();

/**
 * Active MCP transport sessions broken down by UA-classified client.
 * Each entry counts open SSE/streamable-http transports — incremented in
 * `onsessioninitialized`, decremented in `onsessionclosed`. The companion
 * `sessionClient` map records the class captured at session start so
 * decrement bills the same bucket even if the close handler fires after
 * the request UA is gone.
 *
 * Cardinality bounded by {@link CLIENT_CLASSES}. Read by the
 * `mcp.sessions.by_client` gauge providers in `server.tsx`.
 */
const activeSessionsByClient = new Map<ClientClass, number>();
const sessionClient = new Map<string, ClientClass>();

/** Read the current active-session count for a single client class. */
export function getActiveSessionsByClient(client: ClientClass): number {
  return activeSessionsByClient.get(client) ?? 0;
}

/**
 * Test-only: simulate session lifecycle without spinning up a full MCP transport.
 * Mirrors the increment/decrement done in `onsessioninitialized`/`onsessionclosed`
 * so tests can assert read-side correctness and decrement-on-zero behavior.
 *
 * Asserts on duplicate-`sid` track to surface test bugs early — production
 * `onsessioninitialized` is guarded by the SDK's `_initialized` flag, so a
 * second init for the same transport is unreachable; a test that double-tracks
 * is almost certainly a typo.
 *
 * KNOWN TEST-DESIGN GAP: these helpers do NOT exercise the real
 * `WebStandardStreamableHTTPServerTransport` lifecycle (DELETE handler,
 * stream cancellation, manual `close()`). The first v2.20.0 commit
 * over-claimed a leak fix that the helper-only tests could not have caught.
 * An integration test using a real or stubbed transport is on the follow-up
 * list — see ROADMAP "Next" / idle-reaper item.
 * @internal
 */
export function _trackSessionForTest(sid: string, client: ClientClass): void {
  if (sessionClient.has(sid)) {
    throw new Error(`_trackSessionForTest: sid "${sid}" already tracked — likely a test bug`);
  }
  sessionClient.set(sid, client);
  activeSessionsByClient.set(client, (activeSessionsByClient.get(client) ?? 0) + 1);
}

/**
 * Test-only: register a fully-fledged tracked session in the same shape as
 * production `onsessioninitialized` (transports + sessionClient + counts +
 * lastActivity), with an injected mock transport. Exists so reaper tests can
 * exercise the iteration path over `transports` without spinning up a real
 * `WebStandardStreamableHTTPServerTransport`.
 *
 * @param mockTransport stub object exposing at least `close()`
 * @internal
 */
export function _trackFullSessionForTest(
  sid: string,
  client: ClientClass,
  userId: string,
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock
  mockTransport: any,
  lastActivityMs: number,
): void {
  if (sessionClient.has(sid)) {
    throw new Error(`_trackFullSessionForTest: sid "${sid}" already tracked — likely a test bug`);
  }
  sessionClient.set(sid, client);
  activeSessionsByClient.set(client, (activeSessionsByClient.get(client) ?? 0) + 1);
  transports.set(sid, mockTransport);
  sessionOwners.set(sid, userId);
  activeSessionCount.set(userId, (activeSessionCount.get(userId) ?? 0) + 1);
  lastActivity.set(sid, lastActivityMs);
}

/** @internal */
export function _untrackSessionForTest(sid: string): void {
  if (!sessionClient.has(sid)) return; // idempotent — mirrors teardownSession's guard
  const cls = sessionClient.get(sid) ?? "other";
  sessionClient.delete(sid);
  const prev = activeSessionsByClient.get(cls) ?? 0;
  if (prev > 1) activeSessionsByClient.set(cls, prev - 1);
  else activeSessionsByClient.delete(cls);
}

/** @internal */
export function _resetSessionTrackingForTest(): void {
  // Clear cleanupTimers FIRST so any test that triggered the last-session
  // path (which schedules a 5-min setTimeout) doesn't leave a timer handle
  // pinning the event loop after `node --test` finishes the suite.
  for (const t of cleanupTimers.values()) clearTimeout(t);
  cleanupTimers.clear();
  activeSessionsByClient.clear();
  sessionClient.clear();
  lastActivity.clear();
  transports.clear();
  sessionOwners.clear();
  activeSessionCount.clear();
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

/**
 * Module-level teardown shared by the request-handler `onsessionclosed` /
 * `transport.onclose` callbacks AND the idle reaper. Decrements the
 * `mcp.sessions.by_client` gauge buckets, drops the transport from `transports`,
 * fires Telegram-disconnect + cleanup timer when this was the last live MCP
 * session for the user.
 *
 * Idempotent — second call for same sid is a no-op (guard via `sessionClient.has`).
 *
 * @internal — exported only because the reaper lives in this same module;
 *             not meant for external callers.
 */
function teardownSessionImpl(sid: string, userId: string, sessions: SessionManager | null): void {
  if (!sessionClient.has(sid)) return; // already torn down via the other path
  transports.delete(sid);
  sessionOwners.delete(sid);
  lastActivity.delete(sid);

  const cls = sessionClient.get(sid) ?? "other";
  sessionClient.delete(sid);
  const prev = activeSessionsByClient.get(cls) ?? 0;
  if (prev > 1) {
    activeSessionsByClient.set(cls, prev - 1);
  } else {
    activeSessionsByClient.delete(cls);
  }

  const remaining = (activeSessionCount.get(userId) ?? 1) - 1;
  activeSessionCount.set(userId, remaining);
  logger.info(`MCP session closed: ${sid}`, {
    component: "cloud",
    userId: logUser(userId),
    event: "session.close",
    sessionId: sid,
    remaining,
    clientClass: cls,
  });

  // Only disconnect Telegram when the LAST MCP session for this user closes.
  if (remaining > 0) return;
  activeSessionCount.delete(userId);

  // Reaper passes `sessions=null` for users we don't own (defensive — should
  // not happen in practice since reaper iterates only `transports`, all of
  // which were registered through a request handler that knows `sessions`).
  if (!sessions) return;

  sessions.disconnectUser(userId);

  const timer = setTimeout(async () => {
    cleanupTimers.delete(userId);
    logger.info(`Cleanup timer fired, destroying session`, {
      component: "cloud",
      userId: logUser(userId),
      event: "cleanup.fired",
    });
    await sessions.destroyUserSession(userId);
  }, CLEANUP_DELAY_MS);

  cleanupTimers.set(userId, timer);
  logger.info(`Cleanup timer set (${CLEANUP_DELAY_MS / 60000}m)`, {
    component: "cloud",
    userId: logUser(userId),
    event: "cleanup.scheduled",
  });
}

/**
 * Reap MCP transport sessions whose last activity is older than {@link config.mcpIdleReapMs}.
 * Closes the transport (which fires our `onclose` → teardown chain when SDK
 * cooperates) AND drives `teardownSessionImpl` directly to cover the case
 * where `transport.close()` does not fire `onclose` (e.g. transport already
 * detached from its stream — same SDK shape we observed in v2.20.0 review).
 *
 * Idempotent — if a sid is already gone from `sessionClient`, teardown is a no-op.
 *
 * @param nowMs current time in epoch milliseconds — injectable for tests
 * @returns count of sessions reaped
 */
export function reapIdleSessions(nowMs: number = Date.now()): number {
  const threshold = config.mcpIdleReapMs;
  if (threshold <= 0) return 0; // disabled
  const sessions = reaperSessionManager;
  let reaped = 0;
  // Snapshot keys to avoid mutating during iteration.
  const sids = Array.from(transports.keys());
  for (const sid of sids) {
    const seen = lastActivity.get(sid) ?? 0;
    if (nowMs - seen <= threshold) continue;

    const transport = transports.get(sid);
    const userId = sessionOwners.get(sid) ?? "unknown";
    const cls = sessionClient.get(sid) ?? "other";
    logger.info(`Reaping idle MCP session: ${sid}`, {
      component: "cloud",
      event: "session.reap",
      sessionId: sid,
      userId: logUser(userId),
      clientClass: cls,
      idleMs: nowMs - seen,
    });

    // Drive teardown directly first — covers the SDK's silent stream-cancel
    // case where `transport.close()` may not refire `onclose`. Idempotent
    // guard inside teardownSessionImpl prevents double-decrement if onclose
    // still fires.
    teardownSessionImpl(sid, userId, sessions);

    // Then close the transport itself so any lingering SSE write attempts
    // surface as errors instead of silently buffering.
    if (transport) {
      try {
        const maybe = transport.close() as unknown;
        if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
          (maybe as Promise<unknown>).catch(() => {});
        }
      } catch {
        // ignore — transport may already be half-closed
      }
    }
    reaped += 1;
  }
  return reaped;
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;
let reaperSessionManager: SessionManager | null = null;

/**
 * Start the idle reaper timer. Idempotent — safe to call once at boot.
 * Captures a reference to `SessionManager` for the duration of the process
 * so reaped last-of-user sessions also drop the Telegram pool entry.
 *
 * Disables itself if EITHER the TTL or the sweep interval is non-positive
 * (operator footgun: `MCP_IDLE_REAP_INTERVAL_MS=0` would otherwise create
 * a hot-looping `setInterval` and burn CPU on an empty `transports` Map).
 */
export function startIdleReaper(sessions: SessionManager): void {
  reaperSessionManager = sessions;
  if (reaperTimer) return;
  const intervalMs = config.mcpIdleReapIntervalMs;
  if (config.mcpIdleReapMs <= 0 || intervalMs <= 0) {
    logger.info("Idle reaper disabled (non-positive TTL or interval)", {
      component: "cloud",
      event: "session.reap.disabled",
    });
    return;
  }
  reaperTimer = setInterval(() => {
    try {
      const n = reapIdleSessions();
      if (n > 0) {
        logger.info(`Idle reaper swept ${n} session${n === 1 ? "" : "s"}`, {
          component: "cloud",
          event: "session.reap.batch",
          count: n,
        });
      }
    } catch (err) {
      logger.error("Idle reaper crashed (timer continues)", {
        component: "cloud",
        event: "session.reap.error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, intervalMs);
}

/** Stop the reaper timer. Used by graceful shutdown so the process can exit. */
export function stopIdleReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  reaperSessionManager = null;
}

/** @internal */
export function _setReaperSessionsForTest(sessions: SessionManager | null): void {
  reaperSessionManager = sessions;
}

/** Pending cleanup timers per userId — cancelled if user reconnects */
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** How long to wait after last MCP session closes before destroying Telegram session */
const CLEANUP_DELAY_MS = config.sessionCleanupDelayMinutes * 60 * 1000;

/**
 * Create or retrieve an MCP transport for the given request.
 * Each MCP session gets its own McpServer + Transport pair wired to the user's TelegramService.
 */
export async function handleMcpRequest(
  sessions: SessionManager,
  usage: UsageTracker,
  oauth: OAuthProvider,
  destructive: DestructiveGuard,
  uploads: UploadStore,
  userId: string,
  clientName: string,
  req: Request,
): Promise<Response> {
  // Check for existing session via header
  const sessionId = req.headers.get("mcp-session-id");

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    if (transport) {
      // Bump last-activity so the idle reaper does not consider this session
      // abandoned. The reuse path is the hot path — every tool call hits this.
      lastActivity.set(sessionId, Date.now());
      return transport.handleRequest(req);
    }
  }

  // User reconnected — cancel any pending cleanup
  const pendingCleanup = cleanupTimers.get(userId);
  if (pendingCleanup) {
    clearTimeout(pendingCleanup);
    cleanupTimers.delete(userId);
    logger.info(`Cleanup timer cancelled (reconnected)`, {
      component: "cloud",
      userId: logUser(userId),
      event: "cleanup.cancelled",
    });
  }

  // Capture UA-derived client class at session-creation time. The close handler
  // can fire long after the originating request is gone, so we must remember
  // which bucket to decrement — `sessionClient` carries this across the lifetime.
  const clientClass = classifyClient(req.headers.get("user-agent") ?? "");

  // KNOWN LIMITATION: The MCP SDK fires `_onsessionclosed` ONLY from
  // `handleDeleteRequest` (DELETE /mcp). For abandoned sessions (network drop,
  // process exit, idle TCP timeout, "Disconnect" buttons that just stop sending
  // requests) the SDK only deletes its internal `_streamMapping` entry — it
  // does NOT call `transport.close()`, so `transport.onclose` does not fire
  // either. The idle reaper (`reapIdleSessions` + `startIdleReaper`) handles
  // that case via TTL on `lastActivity`. Both DELETE and reaper feed the same
  // `teardownSessionImpl` so accounting stays consistent.
  const teardownSession = (sid: string): void => teardownSessionImpl(sid, userId, sessions);

  // New session — create MCP server + transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      sessionOwners.set(sid, userId);
      activeSessionCount.set(userId, (activeSessionCount.get(userId) ?? 0) + 1);
      sessionClient.set(sid, clientClass);
      activeSessionsByClient.set(clientClass, (activeSessionsByClient.get(clientClass) ?? 0) + 1);
      lastActivity.set(sid, Date.now());
      logger.info(`MCP session started: ${sid}`, {
        component: "cloud",
        userId: logUser(userId),
        event: "session.start",
        sessionId: sid,
        active: activeSessionCount.get(userId),
        clientClass,
      });
    },
    onsessionclosed: teardownSession,
  });

  // Wire `onclose` for any future explicit `transport.close()` callsite (our
  // own shutdown path, manual revocation, etc). NOTE: SDK does NOT call
  // `transport.close()` on client-side abort/network-drop — only the internal
  // `_streamMapping` is cleaned up. So this hook does NOT close the abandoned-
  // session leak; see `teardownSession` rationale block above. Idempotent via
  // `sessionClient.has(sid)` guard inside teardown.
  transport.onclose = () => {
    if (transport.sessionId) teardownSession(transport.sessionId);
  };

  const server = new McpServer({
    name: config.logServiceName,
    version: "0.1.0",
    // PNG listed first because ChatGPT (as of 2026-04) does not appear to consume
    // the SVG variant in its connector avatar — Apps Directory submission requires
    // a 128×128 PNG. The SVG remains as a high-quality fallback for clients that
    // do prefer scalable graphics.
    icons: [
      { src: iconPngUrl, mimeType: "image/png", sizes: ["128x128"] },
      { src: iconPng256Url, mimeType: "image/png", sizes: ["256x256"] },
      { src: iconUrl, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  });

  await sessions.getOrCreateSession(userId);

  // Dynamic lookup: always get the CURRENT telegram instance from the pool
  // This prevents stale references when adoptSession replaces the instance after QR re-login
  const getTelegram = () => {
    const current = sessions.getSession(userId);
    if (!current) throw new Error("No Telegram session — please reconnect");
    return current;
  };

  const requireConnection = async (): Promise<string | null> => {
    try {
      const telegram = getTelegram();
      if (await telegram.ensureConnected()) return null;
      const reason = telegram.lastError ? ` ${telegram.lastError}` : "";
      return `Not connected to Telegram.${reason}`;
    } catch {
      return "Not connected to Telegram. Session not found — please reconnect.";
    }
  };

  const onSessionRevoked = async () => {
    const uid = logUser(userId);
    logger.warn(`Session revoked, cleaning up`, { component: "cloud", userId: uid, event: "session.revoked" }); // telemetry-allow: uid = logUser(userId) hashed above
    await sessions.destroyUserSession(userId);
    // Invalidate all OAuth tokens → ChatGPT gets 401 → refresh fails → triggers re-auth → QR
    const revoked = oauth.revokeAllUserTokens(userId);
    logger.info(`OAuth tokens invalidated after session revoke: ${revoked}`, {
      component: "oauth",
      userId: uid,
      event: "oauth.token.revoke_on_session_death",
    });
  };

  const FREE_TIER_LIMIT = config.freeTierLimit;

  const onToolCall = (toolName: string) => {
    usage.logToolCall(userId, toolName, clientName);
    logger.info(`Tool call: ${toolName}`, {
      component: "tools",
      userId: logUser(userId),
      client: clientName,
      event: "tool.call",
      tool: toolName,
    });
  };

  const checkRateLimit = (toolName: string): string | null => {
    if (FREE_TIER_LIMIT <= 0) return null; // 0 = unlimited
    const todayCount = usage.getTodayCount(userId);
    if (todayCount >= FREE_TIER_LIMIT) {
      incr(RATE_LIMIT_HITS, { tier: "free", tool: toolName });
      logger.warn(`Rate limit hit: ${todayCount}/${FREE_TIER_LIMIT}`, {
        component: "tools",
        userId: logUser(userId),
        event: "rate_limit.hit",
        tool: toolName,
        count: todayCount,
      });
      const base = `Daily limit reached (${todayCount}/${FREE_TIER_LIMIT} calls today).`;
      // The hosted instance has a fair-use cap; self-hosters lift it via FREE_TIER_LIMIT.
      // No paid tier — both messages point at self-host as the unlimited path.
      return `${base} For unlimited usage, self-host the open source server: ${config.sourceRepoUrl}`;
    }
    return null;
  };

  // Cache args summary once per (toolName, args) pair so checkDestructive's
  // pre-handler write and recordDestructive's post-handler write share the
  // exact same audit string — avoids subtle drift if args mutate, and one
  // less call to summarizeArgs per destructive call.
  const lastSummary = new WeakMap<object, string>();
  const summaryFor = (args: unknown): string => {
    if (!args || typeof args !== "object") return "";
    const obj = args as object;
    const cached = lastSummary.get(obj);
    if (cached !== undefined) return cached;
    const s = summarizeArgs(args);
    lastSummary.set(obj, s);
    return s;
  };

  const checkDestructive = (toolName: string, args: unknown): string | null => {
    const summary = summaryFor(args);
    const err = destructive.preflight(userId, toolName, summary);
    if (err) {
      incr(RATE_LIMIT_HITS, { tier: "destructive", tool: toolName });
      logger.warn(`Destructive denied: ${toolName}`, {
        component: "tools",
        userId: logUser(userId),
        event: "destructive.denied",
        tool: toolName,
        // The first sentence of the message classifies the deny reason
        // (Destructive tools are disabled / Daily destructive-action limit reached).
        reason: err.split(".")[0],
      });
    }
    return err;
  };

  const recordDestructive = (toolName: string, args: unknown, result: "ok" | "error"): void => {
    destructive.recordResult(userId, toolName, summaryFor(args), result);
  };

  registerAllAllowedTools(
    server,
    getTelegram,
    requireConnection,
    onSessionRevoked,
    onToolCall,
    checkRateLimit,
    checkDestructive,
    recordDestructive,
    { userId, uploads, fetchUrl: fetchUrlSafely },
  );

  await server.connect(transport);
  return transport.handleRequest(req);
}
