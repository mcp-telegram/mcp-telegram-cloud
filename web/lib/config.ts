/** Server-only config loader for the content site.
 *
 * Mirrors the subset of `mcp-telegram-cloud/src/config.ts` needed by public
 * content pages (Landing/Privacy/Terms). The backend `config.ts` is the
 * source of truth for runtime ENV semantics; this file duplicates the small
 * surface used at render time so we don't pull cloud's full Hono/SQLite
 * dependency tree into the Next.js bundle.
 *
 * Reading process.env directly inside RSC is safe — Next.js renders these
 * pages on the server. None of these values is shipped to the client. */

const optional = (value: string | undefined, fallback: string): string => value?.trim() || fallback;

const httpUrl = (name: string, value: string): string => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Env var ${name} must be an http(s) URL, got protocol "${parsed.protocol}".`);
    }
    return value;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Env var")) throw err;
    throw new Error(`Env var ${name} is not a valid URL: ${value}`);
  }
};

const DEFAULT_SOURCE_REPO_URL = "https://github.com/mcp-telegram/mcp-telegram-cloud";
const DEFAULT_ISSUER = "https://mcp-telegram.com";
// MCP endpoint base. Defaults to the apex (self-hosters serve site + backend
// from one host) but the public hosted deployment overrides it via MCP_BASE_URL
// because the backend lives on its own subdomain (mcp.mcp-telegram.com) while
// the content site is served from a separate host. Keep ISSUER as the apex for
// canonical/SEO; only the connect URL shown to users points at the backend.
const DEFAULT_MCP_BASE_URL = DEFAULT_ISSUER;

const sourceRepoUrl = httpUrl(
  "SOURCE_REPO_URL",
  optional(process.env.SOURCE_REPO_URL, DEFAULT_SOURCE_REPO_URL),
).replace(/\/+$/, "");

const issuer = httpUrl("ISSUER", optional(process.env.ISSUER, DEFAULT_ISSUER)).replace(/\/+$/, "");

const mcpBaseUrl = httpUrl("MCP_BASE_URL", optional(process.env.MCP_BASE_URL, DEFAULT_MCP_BASE_URL)).replace(
  /\/+$/,
  "",
);

export const config = {
  brandName: optional(process.env.BRAND_NAME, "MCP Telegram"),
  issuer,
  mcpBaseUrl,
  sourceRepoUrl,
  issuesUrl: httpUrl("ISSUES_URL", optional(process.env.ISSUES_URL, `${sourceRepoUrl}/issues`)),
  issuesLabel: optional(process.env.ISSUES_LABEL, "GitHub Issues"),
  contactEmail: optional(process.env.CONTACT_EMAIL, ""),
  contactTelegram: optional(process.env.CONTACT_TELEGRAM, "").replace(/^@/, ""),
} as const;

export const iconUrl = `${config.issuer}/icon.svg`;
