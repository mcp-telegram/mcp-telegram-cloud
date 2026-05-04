/**
 * Pure scan logic extracted from `scripts/check-telemetry.ts` so it can be
 * unit-tested without spawning a subprocess. The script wraps this with file
 * walking, CLI flags, and the exit-code contract.
 *
 * This is the runtime-grep half of a two-layer PII guard. The compile-time
 * half lives in `src/telemetry/log-fields.ts` (the `LogFields` whitelist
 * type). Both run in CI; the type stops new PII-shaped keys, the grep
 * catches BLACKLIST keys behind `// telemetry-allow` escape hatches.
 */

/** Blacklisted attribute keys: raw PII, secrets, credentials, payload bodies. */
export const BLACKLIST = [
  "userId",
  "user_id",
  "peer",
  "chatId",
  "chat_id",
  "messageId",
  "message_id",
  "messageText",
  "message_text",
  "text",
  "phone",
  "email",
  "firstName",
  "lastName",
  "username",
  "authKey",
  "auth_key",
  "sessionString",
  "session_string",
  "apiHash",
  "api_hash",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "code",
  "state",
  "authorization",
  "cookie",
] as const;

export interface Finding {
  file: string;
  line: number;
  key: string;
  snippet: string;
}

/**
 * Match logger.<level>( | logger[<level>]( | logger["<level>"]( | recordError(
 * | span.setAttributes(  | <ident>.setAttributes(  (tracer attrs object)
 * | withSpan(name, { attributes: {...} })  — caught by the `attributes:` shape
 *
 * The bracket form (`logger[level](...)`) is used in `src/middleware/access-log.ts`
 * to pick a severity from a runtime variable. Without this branch the grep
 * gate would silently miss any blacklisted attribute passed to that callsite.
 *
 * The `(?<!\.)` lookbehind on the bracket branch rejects `obj.logger[x](`
 * — only the bare `logger` identifier (matching the import) is in scope.
 *
 * `setAttributes(` covers the tracer's bulk-set path. The single-attr form
 * `setAttribute(key, value)` is two positional arguments, not an attrs literal,
 * so the same grep wouldn't catch it; the compile-time `SpanAttrs` whitelist
 * blocks it instead.
 */
const CALL_OPENER =
  /\b(?:logger\.(?:error|warn|info|debug)|(?<!\.)\blogger\s*\[\s*['"]?[a-zA-Z_]+['"]?\s*\]|recordError|setAttributes)\s*\(/;

/** Scan one file's text for blacklisted keys inside logger/recordError attrs.
 * `path` is recorded verbatim in findings; pass whatever label is meaningful. */
export function scanText(text: string, path: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!CALL_OPENER.test(lines[i])) continue;
    // Slice up to 20 lines or until balanced braces of the attrs object.
    const slice = lines.slice(i, Math.min(i + 20, lines.length)).join("\n");
    // Restrict scan to text between the first `{` after the call opener and matching `}`.
    const callIdx = slice.search(CALL_OPENER);
    const objStart = slice.indexOf("{", callIdx);
    if (objStart === -1) continue;
    let depth = 0;
    let objEnd = -1;
    for (let p = objStart; p < slice.length; p++) {
      if (slice[p] === "{") depth++;
      else if (slice[p] === "}") {
        depth--;
        if (depth === 0) {
          objEnd = p;
          break;
        }
      }
    }
    if (objEnd === -1) continue;
    const attrsBlob = slice.slice(objStart, objEnd + 1);

    for (const key of BLACKLIST) {
      const safe = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match `key:` (regular prop) or `key,` / `key }` / end-of-blob (shorthand prop).
      // Closing boundary excludes word chars so `userIdHash` doesn't trip on `userId`.
      const pattern = new RegExp(`(^|[\\s,{])${safe}\\s*(?::|,|\\})`, "m");
      const m = attrsBlob.match(pattern);
      if (!m) continue;
      const offset = m.index ?? 0;
      const beforeMatch = attrsBlob.slice(0, offset + m[0].length);
      const lineOffset = (beforeMatch.match(/\n/g) ?? []).length;
      const absLine = i + lineOffset;
      const sourceLine = lines[absLine] ?? "";
      // Allowlist: explicit opt-out comment OR value goes through logUser(
      if (sourceLine.includes("telemetry-allow")) continue;
      if (sourceLine.includes("logUser(")) continue;
      findings.push({
        file: path,
        line: absLine + 1,
        key,
        snippet: sourceLine.trim(),
      });
    }
  }

  return findings;
}
