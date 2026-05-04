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
  activeSessionsByClient.clear();
  sessionClient.clear();
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
    if (transport) return transport.handleRequest(req);
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
  // either. As a result, gauge state for those sessions persists until process
  // restart. This is symmetric with pre-existing leak shape on `transports` /
  // `activeSessionCount`. An idle-reaper (TTL-based) is the proper fix and is
  // tracked as a follow-up; the metric `mcp.sessions.by_client` is documented
  // as "initialized-and-not-yet-closed" rather than strictly live.
  //
  // We still wire `transport.onclose` because we MAY call `transport.close()`
  // ourselves in future shutdown paths and want both close routes to drain
  // the gauge — guarded by `sessionClient.has(sid)` for idempotency.
  const teardownSession = (sid: string): void => {
    if (!sessionClient.has(sid)) return; // already torn down via the other path
    transports.delete(sid);
    sessionOwners.delete(sid);

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

    // Only disconnect Telegram when the LAST MCP session for this user closes
    if (remaining > 0) return;
    activeSessionCount.delete(userId);

    // Immediately disconnect Telegram client to stop GramJS update loop (no more TIMEOUT spam)
    // Session string is already saved in SQLite — reconnect will restore from it
    sessions.disconnectUser(userId);

    // Schedule full cleanup — if user doesn't reconnect within CLEANUP_DELAY_MS, destroy session
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
  };

  // New session — create MCP server + transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      sessionOwners.set(sid, userId);
      activeSessionCount.set(userId, (activeSessionCount.get(userId) ?? 0) + 1);
      sessionClient.set(sid, clientClass);
      activeSessionsByClient.set(clientClass, (activeSessionsByClient.get(clientClass) ?? 0) + 1);
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
