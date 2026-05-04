/**
 * UA-based coarse client classifier — single source of truth for the `client`
 * label on `http.requests`, `mcp.sessions.by_client`, and access-log records.
 *
 * Cardinality: bounded to the values in {@link CLIENT_CLASSES}. Adding a new
 * bucket requires updating the const list (gauge providers iterate it) and
 * any dashboard widgets that legend on the value.
 *
 * Privacy: takes raw User-Agent header, returns coarse class only — no PII
 * leaves this function. Raw UA must NOT be exported to telemetry as a label.
 */

export const CLIENT_CLASSES = ["claude", "chatgpt", "browser", "bot", "script", "empty", "other"] as const;

export type ClientClass = (typeof CLIENT_CLASSES)[number];

export function classifyClient(ua: string): ClientClass {
  const l = ua.toLowerCase();
  if (l.includes("chatgpt") || l.includes("openai")) return "chatgpt";
  if (l.includes("claude") || l.includes("anthropic")) return "claude";
  if (l.includes("bot") || l.includes("spider") || l.includes("crawler") || l.includes("scan")) return "bot";
  if (l.includes("mozilla") || l.includes("chrome") || l.includes("safari") || l.includes("firefox")) return "browser";
  if (l.includes("node") || l.includes("python") || l.includes("curl") || l.includes("fetch")) return "script";
  if (!l) return "empty";
  return "other";
}
