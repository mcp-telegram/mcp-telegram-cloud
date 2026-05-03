#!/usr/bin/env node
/**
 * Phase A telemetry guard (lint script — runs in CI).
 *
 * Greps `src/**` for `logger.<level>(...)` and `recordError(...)` calls whose
 * `attrs` object literal contains a blacklisted key (raw PII / secrets) without
 * going through a known sanitizer (`logUser(...)`, hashing helper, etc).
 *
 * Detection is intentionally conservative — false positives are acceptable
 * (operator can refactor the call site or add an allowlist comment), false
 * negatives are not.
 *
 * Allowlist (per call-site line):
 * - Lines containing `logUser(` (HMAC-hashed user id)
 * - Lines containing `// telemetry-allow` (explicit opt-out, with a reason comment)
 *
 * Usage:
 *   pnpm check-telemetry          # exit 1 on findings
 *   pnpm check-telemetry --json   # machine-readable report on stdout
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Finding, scanText } from "../src/telemetry/check-telemetry-core.js";

const ROOT = join(import.meta.dirname, "..", "src");
const EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["__tests__", "node_modules", "dist"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (EXTS.has(full.slice(full.lastIndexOf(".")))) {
      yield full;
    }
  }
}

const findings: Finding[] = [];
for (const file of walk(ROOT)) {
  findings.push(...scanText(readFileSync(file, "utf8"), file));
}

const json = process.argv.includes("--json");
if (json) {
  process.stdout.write(`${JSON.stringify({ findings, ok: findings.length === 0 }, null, 2)}\n`);
} else if (findings.length === 0) {
  process.stdout.write("[check-telemetry] ✅ OK — no raw PII keys in logger/recordError attrs\n");
} else {
  process.stdout.write(`[check-telemetry] ❌ ${findings.length} finding(s):\n`);
  for (const f of findings) {
    const rel = f.file.replace(`${ROOT}/`, "src/");
    process.stdout.write(`  ${rel}:${f.line}  key="${f.key}"\n    ${f.snippet}\n`);
  }
  process.stdout.write(
    "\nFix: route the value through logUser(...) (HMAC-hashed) or add `// telemetry-allow` on the line if intentionally allowed.\n",
  );
}

process.exit(findings.length === 0 ? 0 : 1);
