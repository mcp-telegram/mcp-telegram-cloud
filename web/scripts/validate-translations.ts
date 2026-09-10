#!/usr/bin/env bun
/** Validate every messages/<locale>.json mirrors the keyspace of en.json and
 * keeps the brand name out of the places that add it themselves.
 *
 * Fails CI when any locale file is missing keys present in en.json. Extra
 * keys in non-en files are also reported (cleanup hint, not fatal).
 *
 * The brand rules exist because the v2.57.0 rebrand shipped two real defects
 * that every other gate (typecheck, lint, build, keyspace check) passed:
 * a `metaTitle` that already ended with the brand rendered as
 * "… — Brand — Brand" once the root layout's title template appended it again,
 * and a blanket search/replace turned "connecteur MCP Telegram hébergé de
 * {brand}" into "connecteur Brand hébergé de {brand}". Both are invisible
 * until you read the rendered HTML, so they are asserted here instead.
 *
 * Usage:
 *   bun web/scripts/validate-translations.ts
 *   bun --cwd web/ scripts/validate-translations.ts
 *
 * No external deps — uses Bun's built-in JSON IO. */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../lib/config";

/** Keys whose value can end up in Next's `title` and therefore run through the
 * root layout's `template: "%s — <brand>"`. They must not carry the brand.
 *
 * Matching every leaf that ends in "title" is deliberately wider than the keys
 * wired up today (oauthDocs.metaTitle, quickstart.chatgptMetaTitle,
 * privacyPage.title, …): a new page that reuses an existing heading as its
 * title should not be able to reintroduce the doubling. Headings have no
 * business naming the brand either — the site header already shows it.
 *
 * The camelCase boundary is load-bearing: a case-insensitive "ends in title"
 * also swallows `hero.subtitle`, which names the brand on purpose. */
const TITLE_KEY = /(^|\.)([A-Za-z0-9]*[a-z0-9]Title|title)$/;

/** The homepage is the one title the template does NOT touch: it lives in the
 * same route segment as the layout that declares the template. */
const TEMPLATE_EXEMPT_KEY = "metadata.siteTitle";

const here = new URL(".", import.meta.url).pathname;
const messagesDir = join(here, "..", "messages");

type Json = { [k: string]: Json | string | number | boolean | null };

async function loadLocale(file: string): Promise<Json> {
  const raw = await readFile(join(messagesDir, file), "utf8");
  try {
    return JSON.parse(raw) as Json;
  } catch (err) {
    // A malformed locale file would otherwise surface as a bare SyntaxError
    // with no hint of which of the 20 files is broken.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`messages/${file} is not valid JSON: ${reason}`);
    process.exit(2);
  }
}

function collectStrings(obj: unknown, prefix = "", out: [string, string][] = []): [string, string][] {
  if (typeof obj === "string") {
    out.push([prefix, obj]);
    return out;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) collectStrings(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** Brand hygiene: a string may name the brand, or interpolate {brand}, but
 * never both — that combination is the signature of a search/replace that ate
 * a descriptive phrase. Title keys may not name it at all, because the layout
 * template appends it. `siteTitle` is the one exception: the homepage sits in
 * the same route segment as the layout, so no template is applied to it. */
function brandProblems(locale: string, data: unknown): string[] {
  const brand = config.brandName;
  const needle = brand.toLowerCase();
  const problems: string[] = [];
  for (const [key, value] of collectStrings(data)) {
    // Case-insensitive so a shouted or lowercased brand still trips the rule.
    // A locale that TRANSLITERATES the brand (Чатруст) would slip through; that
    // is accepted — detecting it would need a per-locale brand table, and the
    // house style keeps the brand in latin script everywhere.
    if (!value.toLowerCase().includes(needle)) continue;
    if (value.includes("{brand}")) {
      problems.push(`[${locale}] ${key} hardcodes "${brand}" next to the {brand} placeholder: ${value}`);
    }
    if (TITLE_KEY.test(key) && key !== TEMPLATE_EXEMPT_KEY) {
      problems.push(`[${locale}] ${key} contains "${brand}"; the title template already appends it: ${value}`);
    }
  }
  return problems;
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

  errors.push(...brandProblems("en", en));

  for (const file of files) {
    if (file === "en.json") continue;
    const locale = file.replace(/\.json$/, "");
    const data = await loadLocale(file);
    const keys = collectKeys(data);
    errors.push(...brandProblems(locale, data));

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

  console.log(`✓ All ${files.length - 1} locale file(s) match en.json keyspace and pass the brand rules.`);
}

await main();
