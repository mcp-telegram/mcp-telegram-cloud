#!/usr/bin/env node
/**
 * Traefik prefix-list parity gate.
 *
 * The cloud backend serves a fixed set of path prefixes from `src/server.tsx`.
 * The prod Traefik router (`mcp-telegram-infra/stacks/mcp-telegram.yml`) routes
 * those prefixes to the backend service and everything else to the Next.js web
 * catchall. If a NEW backend route is added to `server.tsx` but NOT added to
 * the Traefik prefix list, requests fall through to Next.js → 404 in browser.
 *
 * v2.32.0 hit this when `/accounts` was added — fresh capability URL rendered
 * Next's 404. Comment in yaml said "must stay in lockstep with src/server.tsx"
 * but humans don't enforce that. This script does.
 *
 * Strategy:
 *   1. Parse `src/server.tsx` and collect every `app.route("/<X>", ...)` mount
 *      (plus mountPoints from helper registrars: registerMcpRoutes etc).
 *   2. Parse the Traefik backend router rule from `stacks/mcp-telegram.yml` and
 *      extract every `PathPrefix(`/X`)` + `Path(`/X`)` token.
 *   3. Diff:
 *        - missing  — mount exists in server.tsx but no Traefik rule for it
 *                     → BLOCKER (CI fail)
 *        - stale    — Traefik routes a prefix but no server.tsx mount serves it
 *                     → WARN (does not fail CI; harmless redundancy, but worth
 *                     flagging for cleanup)
 *
 * Path conventions:
 *   - Infra repo is expected at `../mcp-telegram-infra` (sibling to cloud).
 *     If missing, the script exits 0 with a clear "skip" message — CI runs
 *     in a single-repo checkout and the public OSS repo doesn't ship infra
 *     files. Set `TRAEFIK_YAML_PATH` env var to override the location.
 *
 * Usage:
 *   bun scripts/check-traefik-parity.ts          # report + exit code
 *   bun scripts/check-traefik-parity.ts --json   # machine-readable report
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUD_ROOT = resolve(__dirname, "..");
const SERVER_TSX = resolve(CLOUD_ROOT, "src/server.tsx");
const DEFAULT_TRAEFIK_YAML = resolve(CLOUD_ROOT, "../mcp-telegram-infra/stacks/mcp-telegram.yml");
const TRAEFIK_YAML = process.env.TRAEFIK_YAML_PATH ? resolve(process.env.TRAEFIK_YAML_PATH) : DEFAULT_TRAEFIK_YAML;

/**
 * Mounts that come from helper registrars rather than literal `app.route()`
 * calls. Keeping these in sync with the helpers themselves is a smaller
 * surface than re-parsing the helper files — when adding a new helper that
 * mounts on bare-`app`, add its top-level prefixes here.
 *
 * Conditional mounts (gated by env/config) still get listed: Traefik must
 * route them to backend even when the backend declines to mount, otherwise
 * deploying the env var flips backend-on while requests still 404 at the
 * edge.
 */
const HELPER_MOUNTS: Record<string, readonly string[]> = {
  // src/routes/static.tsx
  createStaticRoutes: ["/health", "/icon.svg", "/icon.png", "/icon-256.png", "/.well-known/openai-apps-challenge"],
  // src/oauth-well-known.ts (well-known discovery, mounted on bare app at /)
  createOAuthWellKnownRoutes: ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"],
  // src/routes/mcp.ts — `app.all("/mcp")` + `/mcp/` on bare app
  registerMcpRoutes: ["/mcp"],
};

/**
 * Whitelist of well-known prefix tokens that are intentionally only in the
 * Traefik rule (e.g. `/admin` is reserved for future ops UI but not yet
 * mounted, kept routed to backend so it doesn't accidentally serve the web
 * site). Suppresses the "stale" warning for these.
 */
const TRAEFIK_INTENTIONAL_EXTRAS = new Set<string>([
  "/admin",
  // /authorize legacy alias — actual mount is /oauth/authorize, but historic
  // links and discovery may hit /authorize directly. Traefik routes it to
  // backend; backend returns 404 (not the Next.js 404). Harmless redundancy.
  "/authorize",
]);

interface ParityReport {
  ok: boolean;
  serverMounts: string[];
  traefikPrefixes: string[];
  /** Mounts present in server.tsx but missing from Traefik rule — BLOCKER. */
  missing: string[];
  /** Traefik prefixes with no corresponding server mount — warn-only. */
  stale: string[];
  traefikYamlPath: string;
  skipped?: string;
}

function collectServerMounts(): string[] {
  const src = readFileSync(SERVER_TSX, "utf8");
  const mounts = new Set<string>();

  // Literal `app.route("/<path>", ...)` mounts. `/` (root) is excluded —
  // it covers helper-mounted routes which we enumerate via HELPER_MOUNTS.
  const routeRegex = /app\.route\(\s*"(\/[^"]*)"/g;
  for (const match of src.matchAll(routeRegex)) {
    const path = match[1];
    if (path === "/") continue;
    mounts.add(path);
  }

  // Helper registrars — pull from HELPER_MOUNTS for any helper actually
  // imported and called in server.tsx. Detect by name to avoid hard-coding
  // a fixed set, but only contribute mounts for helpers we know about.
  for (const [helper, prefixes] of Object.entries(HELPER_MOUNTS)) {
    if (src.includes(`${helper}(`) || src.includes(`${helper}({`)) {
      for (const prefix of prefixes) mounts.add(prefix);
    }
  }

  return [...mounts].sort();
}

function readBackendRuleBlock(): string {
  const yaml = readFileSync(TRAEFIK_YAML, "utf8");
  // Find the mcp-backend router rule block. The rule is a folded scalar
  // (`>`), so the value spans multiple lines until the next `traefik.*` key.
  const ruleStart = yaml.indexOf("traefik.http.routers.mcp-backend.rule:");
  if (ruleStart === -1) {
    throw new Error("Traefik backend router rule not found in mcp-telegram.yml");
  }
  // Take everything from the rule key to the next labels key at same indent.
  const ruleEnd = yaml.indexOf("traefik.http.routers.mcp-backend.priority", ruleStart);
  return yaml.slice(ruleStart, ruleEnd === -1 ? undefined : ruleEnd);
}

function collectTraefikPrefixes(): string[] {
  const ruleBlock = readBackendRuleBlock();
  const prefixes = new Set<string>();
  // Match both PathPrefix(`/x`) and Path(`/x`). Backticks must be literal.
  const tokenRegex = /(?:PathPrefix|Path)\(`(\/[^`]+)`\)/g;
  for (const match of ruleBlock.matchAll(tokenRegex)) {
    prefixes.add(match[1]);
  }
  return [...prefixes].sort();
}

/**
 * Host-based routing detector. Since the 2026-06-01 apex-clause removal the
 * backend lives on a dedicated host (`mcp.mcp-telegram.com`) where the Hono
 * app owns EVERY path — there is no Next.js web catchall on that host to fall
 * through to, so path-prefix parity is no longer meaningful. We recognise this
 * shape (a rule with `Host(...)` but zero `PathPrefix`/`Path` tokens) and skip
 * the gate. The gate only protects path-based split-routing (the old apex
 * shared-host setup); if a PathPrefix token ever reappears, the gate re-arms.
 */
function isDedicatedHostRouting(): boolean {
  const ruleBlock = readBackendRuleBlock();
  const hasHost = /Host\(`[^`]+`\)/.test(ruleBlock);
  const hasPathToken = /(?:PathPrefix|Path)\(`\/[^`]+`\)/.test(ruleBlock);
  return hasHost && !hasPathToken;
}

/**
 * A server mount matches a Traefik prefix if the Traefik prefix is the
 * mount path itself OR a path that the mount serves. For our setup,
 * Traefik uses exact PathPrefix tokens that mirror Hono mount paths, so
 * an exact-set match is the right rule. Exception: helper-routed paths
 * like `/.well-known/openai-apps-challenge` are covered by Traefik's
 * shorter `/.well-known` PathPrefix, so we accept any Traefik prefix
 * that is a path-prefix of the server mount.
 */
function isCovered(serverMount: string, traefikPrefixes: Set<string>): boolean {
  if (traefikPrefixes.has(serverMount)) return true;
  for (const tp of traefikPrefixes) {
    if (serverMount === tp || serverMount.startsWith(`${tp}/`)) return true;
  }
  return false;
}

function isMountServingPrefix(traefikPrefix: string, serverMounts: Set<string>): boolean {
  if (serverMounts.has(traefikPrefix)) return true;
  for (const sm of serverMounts) {
    if (sm === traefikPrefix || sm.startsWith(`${traefikPrefix}/`)) return true;
    // Traefik prefix may be a more-specific path than the mount (e.g.
    // Traefik `/.well-known/oauth-authorization-server` and server mount
    // `/.well-known/oauth-authorization-server`). Both directions handled.
    if (traefikPrefix.startsWith(`${sm}/`)) return true;
  }
  return false;
}

function buildReport(): ParityReport {
  // If infra repo isn't present (public OSS checkout), skip gracefully.
  try {
    readFileSync(TRAEFIK_YAML, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        serverMounts: [],
        traefikPrefixes: [],
        missing: [],
        stale: [],
        traefikYamlPath: TRAEFIK_YAML,
        skipped: `Traefik yaml not found at ${TRAEFIK_YAML} — skipping (set TRAEFIK_YAML_PATH to override).`,
      };
    }
    throw e;
  }

  // Dedicated-host routing (post 2026-06-01): backend owns every path on its
  // own host, no shared-host path split to police — skip gracefully.
  if (isDedicatedHostRouting()) {
    return {
      ok: true,
      serverMounts: [],
      traefikPrefixes: [],
      missing: [],
      stale: [],
      traefikYamlPath: TRAEFIK_YAML,
      skipped:
        "backend uses dedicated-host routing (Host(...) with no PathPrefix tokens) — path-prefix parity not applicable.",
    };
  }

  const serverMounts = collectServerMounts();
  const traefikPrefixes = collectTraefikPrefixes();

  const traefikSet = new Set(traefikPrefixes);
  const serverSet = new Set(serverMounts);

  const missing = serverMounts.filter((m) => !isCovered(m, traefikSet));
  const stale = traefikPrefixes.filter(
    (p) => !TRAEFIK_INTENTIONAL_EXTRAS.has(p) && !isMountServingPrefix(p, serverSet),
  );

  return {
    ok: missing.length === 0,
    serverMounts,
    traefikPrefixes,
    missing,
    stale,
    traefikYamlPath: TRAEFIK_YAML,
  };
}

function printHumanReport(r: ParityReport): void {
  if (r.skipped) {
    console.log(`[check-traefik-parity] ⊘ skip — ${r.skipped}`);
    return;
  }
  const stats = `server=${r.serverMounts.length} traefik=${r.traefikPrefixes.length}`;
  if (r.ok && r.stale.length === 0) {
    console.log(`[check-traefik-parity] ✅ OK  (${stats})`);
    return;
  }
  if (r.ok) {
    console.log(`[check-traefik-parity] ✅ OK  (${stats})`);
  } else {
    console.error(`[check-traefik-parity] ❌ FAIL  (${stats})`);
  }

  if (r.missing.length > 0) {
    console.error("");
    console.error(`Missing in Traefik — ${r.missing.length} server mount(s) not routed at the edge:`);
    for (const path of r.missing) console.error(`  • ${path}`);
    console.error("");
    console.error(`Fix: add PathPrefix(\`<path>\`) to traefik.http.routers.mcp-backend.rule in:`);
    console.error(`  ${r.traefikYamlPath}`);
    console.error("Without this, requests fall through to the Next.js web catchall → 404.");
  }

  if (r.stale.length > 0) {
    const ch = r.ok ? console.warn : console.error;
    ch("");
    ch(`Stale in Traefik — ${r.stale.length} prefix(es) not served by any server mount:`);
    for (const path of r.stale) ch(`  • ${path}`);
    ch("");
    ch("These are harmless (backend will return 404 instead of Next.js 404), but");
    ch("consider removing from Traefik rule or adding to TRAEFIK_INTENTIONAL_EXTRAS");
    ch("with a reason if kept on purpose.");
  }
}

const report = buildReport();
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHumanReport(report);
}
process.exit(report.ok ? 0 : 1);
