#!/usr/bin/env bun
/** Translate only the key paths that changed in `messages/en.json`, and merge
 * them into the existing locale files.
 *
 * Why this exists next to `translate.ts`: that script keys off a SHA of the
 * whole `en.json` and rewrites every locale file end to end. A one-section edit
 * would therefore re-translate all 439 strings per locale and silently discard
 * hand-tuned wording that was corrected after the machine pass (for example the
 * Russian imperative fix in v2.54.8). This script touches only the paths you
 * name and leaves every other string byte-identical.
 *
 * Translation goes through the local `claude` CLI, so no API key is required.
 *
 * Usage:
 *   bun scripts/translate-keys.ts --keys /tmp/keys.json            # all locales
 *   bun scripts/translate-keys.ts --keys /tmp/keys.json de fr ja   # a subset
 *
 * The keys file is `{ "added": ["a.b.c"], "changed": ["d.e"] }`; both lists are
 * merged. `en.json` is the source of truth for the English values.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const here = new URL(".", import.meta.url).pathname;
const messagesDir = join(here, "..", "messages");

const RULES = [
  "You are translating UI strings of a privacy policy from English into the target language.",
  "Output ONLY a JSON object mapping each input key to its translation. No prose, no code fences.",
  "Preserve ICU placeholders in {curly braces} verbatim.",
  "Preserve inline tags such as <strong>, <em>, <host>, <repo> and their contents' position.",
  "Keep brand names as-is: Claude, ChatGPT, Telegram, MCP, OAuth, QR.",
  "Use the terminology Telegram itself uses in that language for chat, channel, contact, draft.",
  "This is a legal text: be precise and neutral, never add or drop a factual claim.",
].join("\n");

type Tree = { [k: string]: string | Tree };

/** Parse JSON, reporting *what* failed to parse. A bare SyntaxError here would
 * name neither the locale nor the file, and the model output is the one input
 * that is expected to be malformed sometimes. */
function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${what}: invalid JSON (${reason})`);
  }
}

function get(tree: Tree, path: string): string | undefined {
  const value = path.split(".").reduce<string | Tree | undefined>((node, key) => {
    if (node && typeof node === "object") return node[key];
    return undefined;
  }, tree);
  return typeof value === "string" ? value : undefined;
}

function set(tree: Tree, path: string, value: string): void {
  const parts = path.split(".");
  const last = parts.pop();
  if (!last) return;
  let node = tree;
  for (const key of parts) {
    const next = node[key];
    if (!next || typeof next !== "object") node[key] = {};
    node = node[key] as Tree;
  }
  node[last] = value;
}

/** Rebuild `target` following the key order of `source`, so a newly inserted
 * section lands where it belongs instead of at the end of its parent object. */
function reorder(source: Tree, target: Tree): Tree {
  const out: Tree = {};
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    if (sourceValue && typeof sourceValue === "object") {
      if (targetValue && typeof targetValue === "object") out[key] = reorder(sourceValue, targetValue);
    } else if (typeof targetValue === "string") {
      out[key] = targetValue;
    }
  }
  return out;
}

async function translate(locale: string, payload: Record<string, string>): Promise<Record<string, string>> {
  const prompt = [
    RULES,
    `Target language: ${locale}`,
    "Input:",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");

  const { stdout } = await execFileAsync("claude", ["-p", prompt], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`[${locale}] no JSON in model output`);
  return parseJson<Record<string, string>>(stdout.slice(start, end + 1), `[${locale}] model output`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const keysIndex = argv.indexOf("--keys");
  if (keysIndex === -1 || !argv[keysIndex + 1]) {
    console.error("usage: translate-keys.ts --keys <file.json> [locale...]");
    process.exit(2);
  }
  const keysFile = argv[keysIndex + 1] as string;
  const spec = parseJson<{ added?: string[]; changed?: string[] }>(await readFile(keysFile, "utf8"), keysFile);
  const paths = [...new Set([...(spec.added ?? []), ...(spec.changed ?? [])])];

  const en = parseJson<Tree>(await readFile(join(messagesDir, "en.json"), "utf8"), "en.json");
  const payload: Record<string, string> = {};
  for (const path of paths) {
    const value = get(en, path);
    if (value === undefined) throw new Error(`missing in en.json: ${path}`);
    payload[path] = value;
  }

  const explicit = argv.slice(keysIndex + 2).filter((a) => !a.startsWith("--"));
  const locales =
    explicit.length > 0
      ? explicit
      : (await readdir(messagesDir))
          .filter((f) => f.endsWith(".json") && f !== "en.json")
          .map((f) => f.replace(/\.json$/, ""));

  console.log(`${paths.length} key(s) → ${locales.length} locale(s)`);

  for (const locale of locales) {
    const file = join(messagesDir, `${locale}.json`);
    const tree = parseJson<Tree>(await readFile(file, "utf8"), `${locale}.json`);
    process.stdout.write(`  [${locale}] translating…`);

    const result = await translate(locale, payload);
    const missing = paths.filter((p) => typeof result[p] !== "string");
    if (missing.length > 0) throw new Error(`[${locale}] model omitted ${missing.length} key(s): ${missing[0]}`);

    for (const path of paths) set(tree, path, result[path] as string);

    // `_meta` is not part of en.json; keep it first and untouched.
    const meta = tree._meta;
    const ordered = reorder(en, tree);
    const out: Tree = meta ? { _meta: meta, ...ordered } : ordered;
    await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
    process.stdout.write(" ✓\n");
  }
}

await main();
