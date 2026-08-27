import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager } from "./session-manager.js";
import { type ArgAliases, buildArgAliases } from "./tool-call-interceptor.js";
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
import { ACCOUNTS_TOOLS } from "./tools/accounts.js";
import { CHATS_TOOLS } from "./tools/chats.js";
import { MESSAGING_TOOLS } from "./tools/messaging.js";
import { MISC_TOOLS } from "./tools/misc.js";
import { PROFILE_TOOLS } from "./tools/profile.js";
import { READ_TOOLS } from "./tools/read.js";
import { STARS_TOOLS } from "./tools/stars.js";
import { STATS_TOOLS } from "./tools/stats.js";
import { STORIES_TOOLS } from "./tools/stories.js";
import { UPLOAD_TOOLS } from "./tools/uploads.js";
import type { UploadStore } from "./upload-store.js";
import type { fetchUrlSafely } from "./url-fetcher.js";

export const TOOLS: ToolDefinition[] = [
  ...READ_TOOLS,
  ...MESSAGING_TOOLS,
  ...CHATS_TOOLS,
  ...PROFILE_TOOLS,
  ...STORIES_TOOLS,
  ...STATS_TOOLS,
  ...STARS_TOOLS,
  ...MISC_TOOLS,
  ...UPLOAD_TOOLS,
  ...ACCOUNTS_TOOLS,
];

/**
 * Per-tool argument aliases derived from {@link TOOLS}' own input schemas.
 *
 * Computed once at module load (the catalog is static) and consumed by
 * `installCallToolInterceptor` on every MCP session.
 */
export const ARG_ALIASES: ArgAliases = buildArgAliases(TOOLS);

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
export interface RegisterAllowedToolsExtras {
  /** Phase X: owner of this MCP session, used by upload-backed tools to scope upload IDs. */
  userId?: string;
  /** Phase X: per-user upload store. Required for the 6 FS-bound tools to function. */
  uploads?: UploadStore;
  /** Phase X: SSRF-hardened URL fetcher for the URL variant of upload-backed tools. */
  fetchUrl?: typeof fetchUrlSafely;
  /** v2.32.0 multi-account: session manager for the accounts-* tools. */
  sessions?: SessionManager;
  /** v2.32.0: public-facing base URL (https://mcp-telegram.com) for accounts-add URLs. */
  baseUrl?: string;
}

export function registerAllAllowedTools(
  server: McpServer,
  getTelegram: () => TelegramService,
  requireConnection: RequireConnection,
  onSessionRevoked?: OnSessionRevoked,
  onToolCall?: OnToolCall,
  checkRateLimit?: RateLimitCheck,
  checkDestructive?: DestructiveCheck,
  recordDestructive?: DestructiveRecord,
  extras?: RegisterAllowedToolsExtras,
): void {
  registerAllTools(server, TOOLS, {
    getTelegram,
    requireConnection,
    onSessionRevoked,
    onToolCall,
    checkRateLimit,
    checkDestructive,
    recordDestructive,
    ...(extras?.userId !== undefined && { userId: extras.userId }),
    ...(extras?.uploads !== undefined && { uploads: extras.uploads }),
    ...(extras?.fetchUrl !== undefined && { fetchUrl: extras.fetchUrl }),
    ...(extras?.sessions !== undefined && { sessions: extras.sessions }),
    ...(extras?.baseUrl !== undefined && { baseUrl: extras.baseUrl }),
  });
}
