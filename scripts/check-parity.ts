#!/usr/bin/env node
/**
 * Phase 2.0 parity gate.
 *
 * Compares the cloud whitelist (from `registerReadOnlyTools`) against the upstream
 * `@overpod/mcp-telegram` tool catalog (from `getToolManifest`). Every upstream tool
 * must be either:
 *   - present in the cloud whitelist (intentionally exposed), OR
 *   - present in `EXPLICIT_EXCLUDED` (intentionally not exposed, with a reason)
 *
 * If a new upstream tool is neither — drift — this script exits non-zero and CI
 * blocks the merge. The fix is then a single decision per drifted tool: expose
 * or exclude (with a reason).
 *
 * Usage:
 *   pnpm check-parity         # report + exit code
 *   pnpm check-parity --json  # machine-readable report on stdout
 */

// `src/config.ts` validates env at import time; provide stubs before any src/*
// import is reached. ESM static imports hoist, so we use dynamic imports below
// to ensure these env writes happen first. The script never reads real config.
process.env.ISSUER ??= "https://parity-check.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getToolManifest } from "@overpod/mcp-telegram/manifest";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { EXPLICIT_EXCLUDED } = await import("../src/parity-config.js");
const { registerReadOnlyTools } = await import("../src/tools.js");

/**
 * Opt-in env flags that gate cloud tool registration via `ToolDefinition.requiresEnv`.
 * Force-enable them while introspecting so the parity gate sees the full whitelist —
 * mirrors the same trick `@overpod/mcp-telegram/manifest` plays for its own opt-in tools.
 */
const OPT_IN_ENV_FLAGS = ["MCP_TELEGRAM_ENABLE_GROUP_CALLS", "MCP_TELEGRAM_ENABLE_QUICK_REPLIES"];

function collectCloudWhitelist(): Set<string> {
  const restoreEnv: Array<[string, string | undefined]> = [];
  for (const key of OPT_IN_ENV_FLAGS) {
    restoreEnv.push([key, process.env[key]]);
    process.env[key] = "1";
  }
  try {
    const server: McpServer = new McpServerImpl({ name: "parity-introspect", version: "0.0.0" });
    registerReadOnlyTools(
      server,
      () => ({}) as TelegramService,
      async () => null,
    );
    const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
    if (!registered) {
      throw new Error("Cloud whitelist introspection failed: _registeredTools missing on McpServer");
    }
    return new Set(Object.keys(registered));
  } finally {
    for (const [key, prev] of restoreEnv) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

interface ParityReport {
  ok: boolean;
  upstreamToolCount: number;
  cloudWhitelistCount: number;
  excludedCount: number;
  pendingCount: number;
  /** Tools upstream that are NOT yet in whitelist, NOT excluded, AND NOT in baseline pending. New drift since baseline — block CI. */
  newDrift: string[];
  /** Tools that were pending in baseline but no longer drifted (now in whitelist or excluded). Baseline file should be updated. */
  resolvedPending: string[];
  /** Excluded entries that no longer exist upstream — stale config. */
  staleExclusions: string[];
  /** Whitelisted entries that no longer exist upstream — upstream renamed/removed. */
  unknownInWhitelist: string[];
}

function loadBaseline(): Set<string> {
  // Resolve relative to this file so the script works from any cwd.
  const baselinePath = new URL("./parity-baseline.json", import.meta.url);
  try {
    const content = readFileSync(baselinePath, "utf8");
    const parsed: { pending: string[] } = JSON.parse(content);
    if (!Array.isArray(parsed.pending)) {
      throw new Error("parity-baseline.json: 'pending' must be an array of tool names");
    }
    return new Set(parsed.pending);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw e;
  }
}

function buildReport(): ParityReport {
  const upstream = getToolManifest();
  const upstreamNames = new Set(upstream.tools.map((t) => t.name));
  const cloudWhitelist = collectCloudWhitelist();
  const excluded = new Set(EXPLICIT_EXCLUDED.map((e) => e.name));
  const baselinePending = loadBaseline();

  const newDrift: string[] = [];
  const stillPending: string[] = [];
  for (const name of upstreamNames) {
    if (cloudWhitelist.has(name)) continue;
    if (excluded.has(name)) continue;
    if (baselinePending.has(name)) {
      stillPending.push(name);
      continue;
    }
    newDrift.push(name);
  }

  const resolvedPending: string[] = [];
  for (const name of baselinePending) {
    if (cloudWhitelist.has(name) || excluded.has(name) || !upstreamNames.has(name)) {
      resolvedPending.push(name);
    }
  }

  const staleExclusions: string[] = [];
  for (const name of excluded) {
    if (!upstreamNames.has(name)) staleExclusions.push(name);
  }

  const unknownInWhitelist: string[] = [];
  for (const name of cloudWhitelist) {
    if (!upstreamNames.has(name)) unknownInWhitelist.push(name);
  }

  newDrift.sort();
  resolvedPending.sort();
  staleExclusions.sort();
  unknownInWhitelist.sort();

  return {
    ok:
      newDrift.length === 0 &&
      resolvedPending.length === 0 &&
      staleExclusions.length === 0 &&
      unknownInWhitelist.length === 0,
    upstreamToolCount: upstream.toolCount,
    cloudWhitelistCount: cloudWhitelist.size,
    excludedCount: excluded.size,
    pendingCount: stillPending.length,
    newDrift,
    resolvedPending,
    staleExclusions,
    unknownInWhitelist,
  };
}

function printHumanReport(r: ParityReport): void {
  const stats =
    `upstream=${r.upstreamToolCount} whitelist=${r.cloudWhitelistCount} ` +
    `excluded=${r.excludedCount} pending=${r.pendingCount}`;
  if (r.ok) {
    console.log(`[check-parity] ✅ OK  (${stats})`);
    return;
  }

  console.error(`[check-parity] ❌ FAIL  (${stats})`);

  if (r.newDrift.length > 0) {
    console.error("");
    console.error(`New drift — ${r.newDrift.length} upstream tool(s) added since baseline:`);
    for (const name of r.newDrift) console.error(`  • ${name}`);
    console.error("");
    console.error("Fix: pick one per tool —");
    console.error("  - Add to cloud whitelist (src/tools.ts)");
    console.error("  - Add to EXPLICIT_EXCLUDED (src/parity-config.ts) with a specific reason");
    console.error("  - Add to scripts/parity-baseline.json `pending` if you're deferring");
  }

  if (r.resolvedPending.length > 0) {
    console.error("");
    console.error(`Resolved pending — ${r.resolvedPending.length} baseline-pending tool(s) now exposed or excluded:`);
    for (const name of r.resolvedPending) console.error(`  • ${name}`);
    console.error("");
    console.error("Fix: remove these from scripts/parity-baseline.json `pending` list.");
  }

  if (r.staleExclusions.length > 0) {
    console.error("");
    console.error(`Stale exclusions — ${r.staleExclusions.length} excluded tool(s) no longer exist upstream:`);
    for (const name of r.staleExclusions) console.error(`  • ${name}`);
    console.error("");
    console.error("Fix: remove from EXPLICIT_EXCLUDED in src/parity-config.ts.");
  }

  if (r.unknownInWhitelist.length > 0) {
    console.error("");
    console.error(`Unknown in whitelist — ${r.unknownInWhitelist.length} tool(s) not in upstream catalog:`);
    for (const name of r.unknownInWhitelist) console.error(`  • ${name}`);
    console.error("");
    console.error("Fix: upstream renamed/removed the tool — update src/tools.ts.");
  }
}

const report = buildReport();
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHumanReport(report);
}
process.exit(report.ok ? 0 : 1);
