/**
 * Cloud parity policy: tools intentionally NOT exposed via the cloud whitelist,
 * with a documented reason. The `check-parity` script (scripts/check-parity.ts)
 * uses this list to distinguish "drift" (upstream added a tool, cloud forgot to
 * decide) from "intentionally excluded" (cloud has thought about it and said no).
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
  // Telegram Stars ecosystem (paid). Read-only tools alone are not harmful, but exposing them
  // signals that cloud is in scope for Stars and would invite the matching write/destructive
  // tools (change-stars-subscription, send-paid-reaction, save/convert star gifts) before the
  // destructive infrastructure (Phase 2.1) and Wave 3 opt-in plumbing land. Deferred until
  // Wave 3, when the destructive path can carry the necessary confirmation/UX guarantees.
  {
    name: "telegram-get-stars-status",
    reason:
      "Telegram Stars (paid ecosystem) deferred until Wave 3. Read-only Stars tools are gated alongside the destructive Stars tools to avoid signalling Stars scope before destructive infra (Phase 2.1) lands.",
  },
  {
    name: "telegram-get-stars-transactions",
    reason:
      "Telegram Stars (paid ecosystem) deferred until Wave 3. Read-only Stars tools are gated alongside the destructive Stars tools to avoid signalling Stars scope before destructive infra (Phase 2.1) lands.",
  },
  {
    name: "telegram-get-stars-subscriptions",
    reason:
      "Telegram Stars (paid ecosystem) deferred until Wave 3. Read-only Stars tools are gated alongside the destructive Stars tools to avoid signalling Stars scope before destructive infra (Phase 2.1) lands.",
  },
  {
    name: "telegram-get-stars-topup-options",
    reason:
      "Telegram Stars (paid ecosystem) deferred until Wave 3. Read-only Stars tools are gated alongside the destructive Stars tools to avoid signalling Stars scope before destructive infra (Phase 2.1) lands.",
  },
  {
    name: "telegram-get-available-star-gifts",
    reason:
      "Telegram Stars (paid ecosystem) deferred until Wave 3. Read-only Stars tools are gated alongside the destructive Stars tools to avoid signalling Stars scope before destructive infra (Phase 2.1) lands.",
  },
  {
    name: "telegram-get-saved-star-gifts",
    reason:
      "Telegram Stars (paid ecosystem) deferred until Wave 3. Read-only Stars tools are gated alongside the destructive Stars tools to avoid signalling Stars scope before destructive infra (Phase 2.1) lands.",
  },
  // Filesystem-bound send tools. The upstream tool requires an absolute path on the
  // host's local filesystem; in cloud the `host` is the container running the MCP
  // server, not the user's machine. Exposing them would either fail (no such path)
  // or read arbitrary files from the cloud container's filesystem if the LLM is
  // tricked into supplying a path that does exist (info-leak risk). Deferred until
  // a buffered/HTTPS-fetch upload path lands (Phase X — not on Wave 2/3 critical path).
  {
    name: "telegram-send-file",
    reason:
      "Requires an absolute path on the cloud container filesystem, which the user does not control. Deferred until a buffered/HTTPS-fetch upload path is added.",
  },
  {
    name: "telegram-send-voice",
    reason:
      "Requires an absolute path on the cloud container filesystem, which the user does not control. Deferred until a buffered/HTTPS-fetch upload path is added.",
  },
  {
    name: "telegram-send-video-note",
    reason:
      "Requires an absolute path on the cloud container filesystem, which the user does not control. Deferred until a buffered/HTTPS-fetch upload path is added.",
  },
  {
    name: "telegram-send-album",
    reason:
      "Requires absolute paths on the cloud container filesystem, which the user does not control. Deferred until a buffered/HTTPS-fetch upload path is added.",
  },
  {
    name: "telegram-send-story",
    reason:
      "Requires an absolute path on the cloud container filesystem to upload story media. Deferred alongside the other filesystem-bound send tools until a buffered/HTTPS-fetch upload path is added.",
  },
];
