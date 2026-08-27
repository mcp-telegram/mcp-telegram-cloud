import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";
import type { ToolDefinition } from "./tool-registry.js";

/**
 * Two cross-cutting fixes that must run OUTSIDE the tool registry, because the MCP SDK
 * validates `tools/call` arguments against the Zod input schema *before* it invokes the
 * registered callback (`McpServer.validateToolInput` throws `McpError(InvalidParams)`).
 *
 * 1. **Observability.** A schema-invalid call never reaches `registerAllTools`, so neither
 *    `tool.call` nor `tool.error` is emitted and the failure is invisible in SigNoz while
 *    still being a fully-fledged production failure for the user. This wrapper is the only
 *    place that can see them.
 *
 * 2. **Argument aliases.** LLM clients routinely send `{chatId, message}` to
 *    `telegram-send-message`, because Telethon/GramJS name that field `message` while the
 *    Bot API (and our schema) name it `text`. The call is rejected with
 *    `expected string, received undefined at text`, the user believes the message was sent,
 *    and nothing is logged. Renaming a stray `message` to `text` before validation makes the
 *    call succeed with unambiguous intent, and keeps the advertised schema canonical —
 *    the alternative (making `text` optional so `message` can be accepted) would weaken the
 *    schema for every well-behaved client.
 */

/** Alias source keys tried, in order, for a canonical field the tool actually declares. */
const ALIAS_SOURCES: Readonly<Record<string, readonly string[]>> = {
  text: ["message", "body"],
};

export type ArgAliases = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Derive per-tool alias maps from the tools' own input schemas.
 *
 * Data-driven on purpose: an alias is registered only when the tool declares the canonical
 * key AND does not declare the alias key itself, so a future tool that legitimately has both
 * `text` and `message` fields silently opts out instead of getting its arguments mangled.
 */
export function buildArgAliases(tools: readonly ToolDefinition[]): ArgAliases {
  const byTool = new Map<string, Map<string, string>>();

  for (const tool of tools) {
    if (!tool.inputSchema) continue;
    const declared = new Set(Object.keys(tool.inputSchema));

    for (const [canonical, sources] of Object.entries(ALIAS_SOURCES)) {
      if (!declared.has(canonical)) continue;
      for (const source of sources) {
        if (declared.has(source)) continue;
        let map = byTool.get(tool.name);
        if (!map) {
          map = new Map();
          byTool.set(tool.name, map);
        }
        map.set(source, canonical);
      }
    }
  }

  return byTool;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Rename known alias keys onto their canonical names.
 *
 * Only fires when the canonical key is genuinely absent (`undefined`), so an explicit
 * `text` always wins over a stray `message` and we never silently discard caller intent.
 * Returns the applied renames so the caller can log them; `args` is never mutated in place.
 */
export function normalizeArgs(
  args: unknown,
  aliases: ReadonlyMap<string, string> | undefined,
): { args: unknown; applied: [string, string][] } {
  if (!aliases || aliases.size === 0 || !isPlainObject(args)) return { args, applied: [] };

  const applied: [string, string][] = [];
  let out: Record<string, unknown> | undefined;

  for (const [source, canonical] of aliases) {
    if (args[canonical] !== undefined) continue;
    if (args[source] === undefined) continue;
    out ??= { ...args };
    out[canonical] = out[source];
    delete out[source];
    applied.push([source, canonical]);
  }

  return { args: out ?? args, applied };
}

/**
 * Signature of the SDK's schema-validation failure (`McpServer.validateToolInput`).
 *
 * The SDK does NOT propagate that `McpError` as a JSON-RPC error: its `tools/call` handler
 * catches everything and funnels it through `createToolError()`, which yields an ordinary
 * `{ isError: true }` CallToolResult whose text is the McpError's formatted `.message`
 * (`MCP error -32602: Input validation error: ...`). So the only way to see a schema
 * rejection is to inspect the RESULT — a `catch` block never fires for it.
 */
const VALIDATION_ERROR_MARKER = "Input validation error: Invalid arguments for tool";

/** Extract the SDK validation message from a CallToolResult, or undefined if it isn't one. */
export function readValidationError(result: unknown): string | undefined {
  if (!isPlainObject(result) || result.isError !== true) return undefined;
  if (!Array.isArray(result.content)) return undefined;

  for (const block of result.content) {
    if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") continue;
    if (block.text.includes(VALIDATION_ERROR_MARKER)) return block.text;
  }
  return undefined;
}

/** Best-effort extraction of the offending field from an SDK validation message. */
export function extractInvalidField(message: string): string | undefined {
  return /\bat\s+([A-Za-z0-9_.[\]]+)\s*$/.exec(message.trim())?.[1];
}

export interface InterceptorContext {
  /** Pseudonymous user id, already hashed by the caller. */
  readonly userId?: string;
  /** MCP client name as reported at initialize (Claude, ChatGPT, …). */
  readonly client?: string;
}

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/**
 * Wrap the SDK's `tools/call` handler.
 *
 * Must be called AFTER the tools are registered — `McpServer` installs the handler lazily on
 * the first `registerTool`. Returns false (and logs) when the handler is missing, so an SDK
 * upgrade that moves it degrades to "no aliases, no extra logging" rather than breaking
 * session startup.
 */
export function installCallToolInterceptor(server: McpServer, aliases: ArgAliases, ctx: InterceptorContext): boolean {
  // SAFETY: `Server._requestHandlers` is a plain `Map<method, handler>` populated by the
  // public `setRequestHandler`; it is not exported on the public type, so there is no
  // type-level way to reach it. The shape is asserted at runtime immediately below — a
  // missing map or missing entry disables the feature instead of throwing.
  const raw = (server.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
  const handlers = raw instanceof Map ? raw : undefined;
  const inner = handlers?.get("tools/call");

  if (!handlers || !inner) {
    logger.warn("tools/call handler not found — arg aliases and invalid-args telemetry are disabled", {
      component: "tools",
      event: "tool.interceptor.unavailable",
    });
    return false;
  }

  const base = {
    component: "tools",
    ...(ctx.userId !== undefined && { userId: ctx.userId }),
    ...(ctx.client !== undefined && { client: ctx.client }),
  };

  handlers.set("tools/call", async (request: unknown, extra: unknown) => {
    const envelope = isPlainObject(request) ? request : undefined;
    const params = envelope && isPlainObject(envelope.params) ? envelope.params : undefined;
    const toolName = typeof params?.name === "string" ? params.name : "<unknown>";

    let effective = request;
    if (envelope && params) {
      const { args, applied } = normalizeArgs(params.arguments, aliases.get(toolName));
      if (applied.length > 0) {
        effective = { ...envelope, params: { ...params, arguments: args } };
        for (const [alias, field] of applied) {
          logger.info(`Normalized argument ${alias} → ${field} for ${toolName}`, {
            ...base,
            event: "tool.args_normalized",
            tool: toolName,
            alias,
            field,
          });
        }
      }
    }

    const logInvalidArgs = (message: string) => {
      const field = extractInvalidField(message);
      logger.warn(`Invalid arguments for ${toolName}: ${message}`, {
        ...base,
        event: "tool.invalid_args",
        tool: toolName,
        ...(field !== undefined && { field }),
        error: message,
      });
    };

    try {
      const result = await inner(effective, extra);
      // Primary path today: the SDK swallows its own InvalidParams and returns it as a result.
      const validationError = readValidationError(result);
      if (validationError) logInvalidArgs(validationError);
      return result;
    } catch (e) {
      // Defensive: covers an SDK change (or a `fallbackRequestHandler` path) that lets the
      // McpError propagate instead of being converted into a CallToolResult.
      if (e instanceof McpError && e.code === ErrorCode.InvalidParams) logInvalidArgs(e.message);
      throw e;
    }
  });

  return true;
}
