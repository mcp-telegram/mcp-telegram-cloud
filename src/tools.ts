import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import {
  type DestructiveCheck,
  type DestructiveRecord,
  type OnSessionRevoked,
  type OnToolCall,
  type RateLimitCheck,
  type RequireConnection,
  registerAllTools,
  type ToolDefinition,
} from "./tool-registry.js";
import { CHATS_TOOLS } from "./tools/chats.js";
import { MESSAGING_TOOLS } from "./tools/messaging.js";
import { MISC_TOOLS } from "./tools/misc.js";
import { PROFILE_TOOLS } from "./tools/profile.js";
import { READ_TOOLS } from "./tools/read.js";
import { STARS_TOOLS } from "./tools/stars.js";
import { STATS_TOOLS } from "./tools/stats.js";
import { STORIES_TOOLS } from "./tools/stories.js";

export const TOOLS: ToolDefinition[] = [
  ...READ_TOOLS,
  ...MESSAGING_TOOLS,
  ...CHATS_TOOLS,
  ...PROFILE_TOOLS,
  ...STORIES_TOOLS,
  ...STATS_TOOLS,
  ...STARS_TOOLS,
  ...MISC_TOOLS,
];

/**
 * Register all whitelisted Telegram tools on the given MCP server.
 *
 * Catalog covers read-only, safe state-change, and write operations as the cloud
 * whitelist grows toward upstream parity. The parity gate (`scripts/check-parity.ts`)
 * enforces that every upstream tool is either here or in `EXPLICIT_EXCLUDED`.
 *
 * Thin wrapper around the data-driven registry — new tools should be added as
 * entries to a domain file under `src/tools/` rather than as new function calls here.
 */
export function registerAllAllowedTools(
  server: McpServer,
  getTelegram: () => TelegramService,
  requireConnection: RequireConnection,
  onSessionRevoked?: OnSessionRevoked,
  onToolCall?: OnToolCall,
  checkRateLimit?: RateLimitCheck,
  checkDestructive?: DestructiveCheck,
  recordDestructive?: DestructiveRecord,
): void {
  registerAllTools(server, TOOLS, {
    getTelegram,
    requireConnection,
    onSessionRevoked,
    onToolCall,
    checkRateLimit,
    checkDestructive,
    recordDestructive,
  });
}
