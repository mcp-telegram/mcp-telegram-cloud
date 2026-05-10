#!/usr/bin/env bun
/** Validate every messages/<locale>.json mirrors the keyspace of en.json.
 *
 * Fails CI when any locale file is missing keys present in en.json. Extra
 * keys in non-en files are also reported (cleanup hint, not fatal).
 *
 * Usage:
 *   bun web/scripts/validate-translations.ts
 *   bun --cwd web/ scripts/validate-translations.ts
 *
 * No external deps — uses Bun's built-in JSON IO. */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const messagesDir = join(here, "..", "messages");

type Json = { [k: string]: Json | string | number | boolean | null };

async function loadLocale(file: string): Promise<Json> {
  const raw = await readFile(join(messagesDir, file), "utf8");
  return JSON.parse(raw) as Json;
}

function collectKeys(obj: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const inner of collectKeys(v, path)) out.add(inner);
      } else {
        out.add(path);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const files = (await readdir(messagesDir)).filter((f) => f.endsWith(".json"));
  if (!files.includes("en.json")) {
    console.error("messages/en.json missing — cannot validate.");
    process.exit(2);
  }

  const en = await loadLocale("en.json");
  const enKeys = collectKeys(en);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    if (file === "en.json") continue;
    const locale = file.replace(/\.json$/, "");
    const data = await loadLocale(file);
    const keys = collectKeys(data);

    const missing = [...enKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !enKeys.has(k));

    if (missing.length > 0) {
      errors.push(`[${locale}] missing ${missing.length} key(s):`);
      for (const m of missing.slice(0, 8)) errors.push(`  - ${m}`);
      if (missing.length > 8) errors.push(`  … and ${missing.length - 8} more`);
    }
    if (extra.length > 0) {
      warnings.push(`[${locale}] has ${extra.length} extra key(s) not in en.json:`);
      for (const x of extra.slice(0, 5)) warnings.push(`  - ${x}`);
      if (extra.length > 5) warnings.push(`  … and ${extra.length - 5} more`);
    }
  }

  if (warnings.length > 0) {
    console.log("Warnings:");
    for (const w of warnings) console.log(w);
    console.log("");
  }

  if (errors.length > 0) {
    console.error("Errors:");
    for (const e of errors) console.error(e);
    process.exit(1);
  }

  console.log(`✓ All ${files.length - 1} locale file(s) match en.json keyspace.`);
}

await main();
