import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { logger } from "./logger.js";
import type { SessionManager } from "./session-manager.js";
import { incr, observe, TOOL_CALLS, TOOL_DURATION } from "./telemetry/metrics.js";
import { getActiveSpanContext, SpanKind, withSpan } from "./telemetry/tracer.js";
import { deriveTitle } from "./tools/helpers.js";
import type { UploadStore } from "./upload-store.js";
import type { fetchUrlSafely } from "./url-fetcher.js";

export type RequireConnection = () => Promise<string | null>;
export type OnSessionRevoked = () => Promise<void>;
export type RateLimitCheck = (toolName: string) => string | null;
export type OnToolCall = (toolName: string) => void;
/** Phase 2.1 hook for tools whose annotation has `destructiveHint=true`. Returns
 * a human-readable error to short-circuit, or null to proceed. The hook is
 * responsible for writing its own audit row on deny — the registry only relays. */
export type DestructiveCheck = (toolName: string, args: unknown) => string | null;
/** Phase 2.1 result hook: invoked after a destructive tool finishes (success or
 * thrown). The registry passes a normalized outcome so the guard can record an
 * audit row without re-running its summarizer. */
export type DestructiveRecord = (toolName: string, args: unknown, result: "ok" | "error") => void;

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDeps {
  readonly telegram: TelegramService;
  /** Owner of the active MCP session. Set by mcp-handler.ts; absent in unit-test fixtures
   * that exercise tools not requiring user identity. Phase X upload tools require it. */
  readonly userId?: string;
  /** Phase X: per-user pending uploads. Required for the 6 FS-bound tools
   * (`telegram-send-file/voice/video-note/album/story`, `telegram-set-profile-photo`). */
  readonly uploads?: UploadStore;
  /** Phase X: SSRF-hardened URL fetcher. Required for the URL variant of the 6 FS-bound tools. */
  readonly fetchUrl?: typeof fetchUrlSafely;
  /** v2.32.0 multi-account: session manager handle for the `accounts-*` tools. */
  readonly sessions?: SessionManager;
  /** v2.32.0: public-facing base URL used by `accounts-add` to build the QR-login link. */
  readonly baseUrl?: string;
}

type Args<TShape extends ZodRawShapeCompat> = ShapeOutput<TShape>;

export interface ToolDefinition<TShape extends ZodRawShapeCompat = ZodRawShapeCompat> {
  name: string;
  description: string;
  /**
   * Optional human-readable display title (MCP `tool.title`). The Claude Connectors
   * Directory requires every tool to carry one. When omitted, the registry derives it
   * from `name` via {@link deriveTitle}; set this only to override (e.g. acronyms).
   */
  title?: string;
  inputSchema?: TShape;
  annotations: ToolAnnotations;
  /** Skip requireConnection() — tool handles disconnected state itself (e.g. telegram-status). */
  skipRequireConnection?: boolean;
  /**
   * Opt-in env flag: tool is registered only when `process.env[requiresEnv] === "1"`.
   * Mirrors upstream's opt-in pattern (e.g. MCP_TELEGRAM_ENABLE_GROUP_CALLS) so self-hosters
   * can disable categories of tools by overriding the env in their image/compose.
   */
  requiresEnv?: string;
  /** Synchronous pre-handler check, runs after rate-limit but before requireConnection. */
  preValidate?: (args: Args<TShape>) => CallToolResult | null;
  /** Main handler. Errors thrown propagate to handleToolError unless onError handles them. */
  handler: (args: Args<TShape>, deps: ToolDeps) => Promise<CallToolResult>;
  /** Custom error mapper. Return a result to short-circuit, null to fall through to default. */
  onError?: (e: unknown) => CallToolResult | null;
}

const AUTH_ERROR_PATTERNS = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
];

function isAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return AUTH_ERROR_PATTERNS.some((p) => msg.includes(p));
}

const SESSION_REVOKED_MSG =
  "Telegram session was revoked or expired. Please reconnect: Disconnect → Connect again in your app settings.";

function handleToolError(e: unknown, onRevoked: OnSessionRevoked, toolName: string): CallToolResult {
  const msg = (e as Error).message ?? String(e);
  if (isAuthError(e)) {
    logger.warn(`Auth error in ${toolName}: ${msg}`, {
      component: "tools",
      event: "tool.auth_error",
      tool: toolName,
    });
    onRevoked().catch(() => {});
    return { content: [{ type: "text", text: SESSION_REVOKED_MSG }], isError: true };
  }
  logger.error(`Tool error in ${toolName}: ${msg}`, {
    component: "tools",
    event: "tool.error",
    tool: toolName,
    error: msg,
  });
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

export interface RegisterAllOptions {
  getTelegram: () => TelegramService;
  requireConnection: RequireConnection;
  onSessionRevoked?: OnSessionRevoked;
  onToolCall?: OnToolCall;
  checkRateLimit?: RateLimitCheck;
  /** Pre-handler check for destructive tools (annotation `destructiveHint=true`).
   * Skipped for non-destructive tools — they never reach the guard.
   * Both `checkDestructive` and `recordDestructive` should be wired together;
   * the registry will not call one without the other being meaningful. */
  checkDestructive?: DestructiveCheck;
  recordDestructive?: DestructiveRecord;
  /** Phase X: piped through to {@link ToolDeps.userId} for upload-backed tools. */
  userId?: string;
  /** Phase X: piped through to {@link ToolDeps.uploads}. */
  uploads?: UploadStore;
  /** Phase X: piped through to {@link ToolDeps.fetchUrl}. */
  fetchUrl?: typeof fetchUrlSafely;
  /** v2.32.0: piped through to {@link ToolDeps.sessions} for `accounts-*` tools. */
  sessions?: SessionManager;
  /** v2.32.0: piped through to {@link ToolDeps.baseUrl}. */
  baseUrl?: string;
}

/**
 * Wire a list of ToolDefinition entries onto an MCP server, applying common cross-cutting concerns
 * (rate-limit check → onToolCall logging → connection check → handler invocation → duration logging
 * → centralized error mapping).
 */
export function registerAllTools(server: McpServer, tools: readonly ToolDefinition[], opts: RegisterAllOptions): void {
  const onRevoked = opts.onSessionRevoked ?? (async () => {});

  for (const tool of tools) {
    if (tool.requiresEnv && process.env[tool.requiresEnv] !== "1") {
      logger.info(`Skipping tool ${tool.name}: env ${tool.requiresEnv} not set`, {
        component: "tools",
        event: "tool.skipped",
        tool: tool.name,
        env: tool.requiresEnv,
      });
      continue;
    }

    const config: {
      title: string;
      description: string;
      annotations: ToolAnnotations;
      inputSchema?: ZodRawShapeCompat;
    } = {
      title: tool.title ?? deriveTitle(tool.name),
      description: tool.description,
      annotations: tool.annotations,
    };
    if (tool.inputSchema) config.inputSchema = tool.inputSchema;

    const isDestructive = tool.annotations.destructiveHint;

    server.registerTool(tool.name, config, async (rawArgs: unknown) => {
      opts.onToolCall?.(tool.name);
      const limitErr = opts.checkRateLimit?.(tool.name);
      if (limitErr) return { content: [{ type: "text", text: limitErr }] };

      // biome-ignore lint/suspicious/noExplicitAny: SDK passes opaque args; tool handler casts via shape.
      const args = (rawArgs ?? {}) as any;

      const preErr = tool.preValidate?.(args);
      if (preErr) return preErr;

      if (isDestructive && opts.checkDestructive) {
        const destErr = opts.checkDestructive(tool.name, args);
        if (destErr) return { content: [{ type: "text", text: destErr }], isError: true };
      }

      if (!tool.skipRequireConnection) {
        const connErr = await opts.requireConnection();
        if (connErr) return { content: [{ type: "text", text: connErr }] };
      }

      // Wrap handler in a child span. Parent context (HTTP server-span) is
      // picked up via AsyncLocalStorage from the surrounding request — when
      // the tool is invoked outside an HTTP context (rare; SDK direct call),
      // the span becomes a fresh root, which is fine for trace exploration.
      const parent = getActiveSpanContext() ?? null;
      const start = Date.now();
      return withSpan(
        `mcp.tool ${tool.name}`,
        {
          kind: SpanKind.INTERNAL,
          parent,
          attributes: { component: "mcp", "mcp.tool": tool.name },
        },
        async (span) => {
          try {
            // For tools that skip requireConnection (e.g. accounts-list runs
            // even when no Telegram session is alive) `getTelegram()` can throw.
            // The handler is opted out via `skipRequireConnection: true` and
            // works through `sessions` instead, so we tolerate the absence.
            let telegram: TelegramService;
            try {
              telegram = opts.getTelegram();
            } catch (err) {
              if (!tool.skipRequireConnection) throw err;
              // Dummy placeholder only reachable from handlers that don't dereference
              // `telegram`; the cast lets us keep `telegram` non-nullable in ToolDeps.
              telegram = undefined as unknown as TelegramService;
            }
            const deps: ToolDeps = {
              telegram,
              ...(opts.userId !== undefined && { userId: opts.userId }),
              ...(opts.uploads !== undefined && { uploads: opts.uploads }),
              ...(opts.fetchUrl !== undefined && { fetchUrl: opts.fetchUrl }),
              ...(opts.sessions !== undefined && { sessions: opts.sessions }),
              ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
            };
            const result = await tool.handler(args, deps);
            const duration = Date.now() - start;
            const outcome = result.isError === true ? "error" : "ok";
            span.setAttribute("mcp.outcome", outcome);
            incr(TOOL_CALLS, { tool: tool.name, outcome });
            observe(TOOL_DURATION, duration, { tool: tool.name, outcome });
            logger.info(`Tool ${tool.name} completed in ${duration}ms`, {
              component: "tools",
              event: "tool.duration",
              tool: tool.name,
              durationMs: duration,
            });
            if (isDestructive) {
              // `result.isError === true` is the convention for handler-returned faults;
              // record those as 'error' so the audit page distinguishes denied/error/ok.
              opts.recordDestructive?.(tool.name, args, outcome);
            }
            return result;
          } catch (e) {
            const duration = Date.now() - start;
            span.setAttribute("mcp.outcome", "error");
            incr(TOOL_CALLS, { tool: tool.name, outcome: "error" });
            observe(TOOL_DURATION, duration, { tool: tool.name, outcome: "error" });
            if (isDestructive) {
              opts.recordDestructive?.(tool.name, args, "error");
            }
            const custom = tool.onError?.(e);
            if (custom) return custom;
            return handleToolError(e, onRevoked, tool.name);
          }
        },
      );
    });
  }
}
