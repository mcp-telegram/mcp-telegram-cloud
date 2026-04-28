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
];
