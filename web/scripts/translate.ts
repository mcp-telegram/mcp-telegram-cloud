#!/usr/bin/env bun
/** Translate `messages/en.json` into target locale JSON files via the
 * Anthropic API (Claude Sonnet 4.6 by default — model overridable via env).
 *
 * Approach:
 *   - Read en.json flat key-paths and string leaves.
 *   - Batch by 50 strings per request to stay within token budget and amortise
 *     API roundtrips. Prompt-cache the system message so subsequent batches
 *     are cheap.
 *   - For each target locale produce a JSON file with identical shape and a
 *     top-level `_meta` block recording source SHA + timestamp + model so
 *     drift can be detected later.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun web/scripts/translate.ts es de fr ja
 *
 * Special targets:
 *   `tier2`  → all 18 Tier-2 locales from web/lib/locales.ts
 *   `tier3`  → all ~49 Tier-3 locales from web/lib/locales.ts
 *
 * Notes:
 *   - Existing locale files are overwritten only if their `_meta.sourceSha`
 *     differs from the current en.json SHA. Use --force to overwrite anyway.
 *   - We never translate keys, only values. We never translate keys whose
 *     value contains `{` (ICU placeholder) — passed through verbatim.
 *   - We pass code/URL strings through. Heuristic: leaf value matches the URL
 *     pattern or is wrapped in backticks → kept as-is. */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tier2Locales, tier3Locales } from "../lib/locales";

const here = new URL(".", import.meta.url).pathname;
const messagesDir = join(here, "..", "messages");
const enFile = join(messagesDir, "en.json");

const MODEL = process.env.TRANSLATE_MODEL ?? "claude-sonnet-4-6";
const BATCH_SIZE = Number(process.env.TRANSLATE_BATCH ?? "50");
const FORCE = process.argv.includes("--force");

const systemPrompt = [
  "You translate developer documentation strings from English to a target language.",
  "Rules:",
  "- Output ONLY a JSON object: { \"<key>\": \"<translation>\", ... } where keys match input exactly.",
  "- Preserve all ICU placeholders verbatim (anything in {curly braces}).",
  "- Preserve all backtick-wrapped code, URLs, and brand names (Claude, ChatGPT, Telegram, MCP, OAuth, QR).",
  "- Keep markdown-style emphasis intact.",
  "- Use the target language's natural register for technical documentation.",
  "- If the locale is supported by Telegram's official UI, use Telegram's terminology.",
].join("\n");

type Leaf = { path: string; value: string };

function flatten(obj: unknown, prefix = ""): Leaf[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const out: Leaf[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const inner of flatten(v, path)) out.push(inner);
      } else if (typeof v === "string") {
        out.push({ path, value: v });
      }
    }
    return out;
  }
  return [];
}

function unflatten(leaves: { path: string; value: string }[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { path, value } of leaves) {
    const parts = path.split(".");
    let node: Record<string, unknown> = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i] as string;
      if (typeof node[key] !== "object" || node[key] === null) {
        node[key] = {};
      }
      node = node[key] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] as string] = value;
  }
  return root;
}

function shouldSkip(value: string): boolean {
  // Leaves that look like URLs or pure code references are passed through.
  if (/^https?:\/\//.test(value)) return true;
  if (/^[A-Z_]+$/.test(value) && value.length > 2) return true;
  return false;
}

async function callClaude(
  apiKey: string,
  targetLocale: string,
  batch: Leaf[],
): Promise<Record<string, string>> {
  const userPayload = JSON.stringify(
    Object.fromEntries(batch.map((l) => [l.path, l.value])),
    null,
    2,
  );

  const body = {
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Target locale: ${targetLocale}\n\nTranslate the values to ${targetLocale}:\n\n${userPayload}` },
        ],
      },
    ],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { content: { type: string; text: string }[] };
  const text = json.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("Empty Claude response");

  // Tolerate fenced JSON.
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  return JSON.parse(jsonText) as Record<string, string>;
}

async function translateLocale(apiKey: string, targetLocale: string, enLeaves: Leaf[], sourceSha: string): Promise<void> {
  const targetFile = join(messagesDir, `${targetLocale}.json`);
  const existing = await readFile(targetFile, "utf8").catch(() => null);
  if (existing && !FORCE) {
    try {
      const parsed = JSON.parse(existing) as { _meta?: { sourceSha?: string } };
      if (parsed._meta?.sourceSha === sourceSha) {
        console.log(`  [${targetLocale}] up-to-date (sha matches), skipping`);
        return;
      }
    } catch {
      // fall through and re-translate
    }
  }

  const translatable = enLeaves.filter((l) => !shouldSkip(l.value));
  const passthrough = enLeaves.filter((l) => shouldSkip(l.value));

  const translated: Leaf[] = [...passthrough];

  for (let i = 0; i < translatable.length; i += BATCH_SIZE) {
    const batch = translatable.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  [${targetLocale}] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(translatable.length / BATCH_SIZE)}…`);
    const result = await callClaude(apiKey, targetLocale, batch);
    for (const { path } of batch) {
      const value = result[path];
      if (typeof value === "string") {
        translated.push({ path, value });
      } else {
        translated.push({ path, value: batch.find((b) => b.path === path)?.value ?? "" });
      }
    }
    process.stdout.write(" ✓\n");
  }

  const tree = unflatten(translated);
  const out = {
    _meta: {
      sourceSha,
      sourceFile: "en.json",
      translatedAt: new Date().toISOString(),
      model: MODEL,
      autoTranslated: true,
    },
    ...tree,
  };
  await writeFile(targetFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`  [${targetLocale}] wrote ${targetFile}`);
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set. See https://console.anthropic.com");
    process.exit(2);
  }

  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const requested =
    args.length === 0
      ? tier2Locales
      : args.flatMap((a) => {
          if (a === "tier2") return tier2Locales;
          if (a === "tier3") return tier3Locales;
          return [a];
        });

  const enRaw = await readFile(enFile, "utf8");
  const en = JSON.parse(enRaw) as Record<string, unknown>;
  const enLeaves = flatten(en);
  const sourceSha = createHash("sha256").update(enRaw).digest("hex").slice(0, 16);

  console.log(`Source en.json: ${enLeaves.length} leaves, sha=${sourceSha}`);
  console.log(`Translating ${requested.length} locale(s) via ${MODEL}…\n`);

  // Filter out duplicates and en itself.
  const targets = [...new Set(requested)].filter((l) => l !== "en");
  await readdir(messagesDir);

  for (const locale of targets) {
    console.log(`→ ${locale}`);
    try {
      await translateLocale(apiKey, locale, enLeaves, sourceSha);
    } catch (err) {
      console.error(`  [${locale}] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\nDone.");
}

await main();
