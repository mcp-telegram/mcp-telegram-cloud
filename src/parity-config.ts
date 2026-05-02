/**
 * Cloud parity policy: tools intentionally NOT exposed via the cloud whitelist,
 * with a documented reason. The `check-parity` script (scripts/check-parity.ts)
 * uses this list to distinguish "drift" (upstream added a tool, cloud forgot to
 * decide) from "intentionally excluded" (cloud has thought about it and said no).
 *
 * A tool can also live in one of two non-excluded states:
 *   - **Opt-in env-flag gated** — registered in cloud whitelist with `requiresEnv` on
 *     the ToolDefinition (e.g. `MCP_TELEGRAM_ENABLE_STARS`, `MCP_TELEGRAM_ENABLE_GROUP_CALLS`,
 *     `MCP_TELEGRAM_ENABLE_QUICK_REPLIES`). Server-default OFF; the parity gate force-enables
 *     them while introspecting (see `OPT_IN_ENV_FLAGS` in `scripts/check-parity.ts`). They DO
 *     count toward the whitelist for parity purposes.
 *   - **Pending** — in `scripts/parity-baseline.json`, deferred to a future wave; the parity
 *     gate accepts these without flagging drift.
 *
 * Adding a tool here is a deliberate cloud-policy choice — a code reviewer
 * should challenge each entry. Reasons must be specific, not generic.
 */
export interface ExclusionEntry {
  name: string;
  reason: string;
}

export const EXPLICIT_EXCLUDED: ExclusionEntry[] = [
  {
    name: "telegram-login",
    reason:
      "Cloud uses its own OAuth + QR login flow. The upstream `telegram-login` tool would compete with that flow and could be invoked at the wrong layer.",
  },
  {
    name: "telegram-logout",
    reason:
      "Cloud uses OAuth `revoke` + `destroyUserSession()` to log a user out. Exposing the upstream tool would let an LLM forcibly log the user out without going through the cloud's session lifecycle.",
  },
  {
    name: "telegram-terminate-session",
    reason:
      "Permanent exclusion: the upstream tool is dual-mode — terminate a specific session by hash, or `terminateAllOther=true` to revoke every session except the caller's. The all-other path is the worry: a prompt-injected LLM call could revoke the user's official Telegram clients on phone/desktop in one round-trip while the cloud session keeps working, leaving the user locked out of their own UI. The risk-vs-utility asymmetry is unfavorable. Users should manage sessions via official Telegram clients.",
  },
  // Phase X (cloud v2.15.0) — the 6 FS-bound media tools previously listed here have
  // been re-exposed via a `source` discriminated union: { kind: "upload", uploadId } |
  // { kind: "url", url }. Bytes flow user → /my/upload (cookie-auth multipart) → SQLite
  // pending_uploads → temp file → upstream method → cleanup, OR cloud fetches a public
  // https:// URL with SSRF protection (private IPs, DNS rebinding, redirects all gated).
  // No filesystem path ever crosses the LLM tool boundary.
  // See src/upload-store.ts, src/url-fetcher.ts, src/tools/uploads.ts.
];
