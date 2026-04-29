import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import { logger } from "./logger.js";

export type RequireConnection = () => Promise<string | null>;
export type OnSessionRevoked = () => Promise<void>;
export type RateLimitCheck = (toolName: string) => string | null;
export type OnToolCall = (toolName: string) => void;

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDeps {
  readonly telegram: TelegramService;
}

type Args<TShape extends ZodRawShapeCompat> = ShapeOutput<TShape>;

export interface ToolDefinition<TShape extends ZodRawShapeCompat = ZodRawShapeCompat> {
  name: string;
  description: string;
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
      description: string;
      annotations: ToolAnnotations;
      inputSchema?: ZodRawShapeCompat;
    } = {
      description: tool.description,
      annotations: tool.annotations,
    };
    if (tool.inputSchema) config.inputSchema = tool.inputSchema;

    server.registerTool(tool.name, config, async (rawArgs: unknown) => {
      opts.onToolCall?.(tool.name);
      const limitErr = opts.checkRateLimit?.(tool.name);
      if (limitErr) return { content: [{ type: "text", text: limitErr }] };

      // biome-ignore lint/suspicious/noExplicitAny: SDK passes opaque args; tool handler casts via shape.
      const args = (rawArgs ?? {}) as any;

      const preErr = tool.preValidate?.(args);
      if (preErr) return preErr;

      if (!tool.skipRequireConnection) {
        const connErr = await opts.requireConnection();
        if (connErr) return { content: [{ type: "text", text: connErr }] };
      }

      const start = Date.now();
      try {
        const result = await tool.handler(args, { telegram: opts.getTelegram() });
        const duration = Date.now() - start;
        logger.info(`Tool ${tool.name} completed in ${duration}ms`, {
          component: "tools",
          event: "tool.duration",
          tool: tool.name,
          durationMs: duration,
        });
        return result;
      } catch (e) {
        const custom = tool.onError?.(e);
        if (custom) return custom;
        return handleToolError(e, onRevoked, tool.name);
      }
    });
  }
}
