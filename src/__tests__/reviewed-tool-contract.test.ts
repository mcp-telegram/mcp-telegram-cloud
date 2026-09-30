/**
 * Guard for the tool contract that a directory reviewer is testing (issue #51).
 *
 * A directory review runs against the live server but judges it by the tool
 * definitions captured at submission: names, titles, annotations and arguments.
 * If we rename a tool, flip an annotation, add a required argument or expose a
 * tool the reviewer never saw, the reviewer's test cases fail and the review
 * starts over. `fixtures/reviewed-tool-contract.json` is that captured contract.
 *
 * The test lists tools exactly as the hosted image serves them: the real
 * registry, the `MCP_TELEGRAM_ENABLE_*` flags from the Dockerfile, and the
 * SDK's own `tools/list` over an in-memory transport.
 *
 * Allowed without touching the fixture: new OPTIONAL arguments and description
 * wording. Everything else needs a new submission; update the fixture in the
 * same PR as that submission. Rules: pinned issue #52 (review freeze).
 */
process.env.ISSUER ??= "https://reviewed-tool-contract-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { registerAllTools } = await import("../tool-registry.js");
const { TOOLS } = await import("../tools.js");

interface ReviewedTool {
  name: string;
  title: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  required: string[];
  properties: string[];
}

interface ListedTool {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  inputSchema: { required?: string[]; properties?: Record<string, unknown> };
}

const contract = JSON.parse(
  readFileSync(new URL("./fixtures/reviewed-tool-contract.json", import.meta.url), "utf8"),
) as {
  review: string;
  /** Tools already live before this guard existed but missing from the review snapshot. Do not add to this list. */
  servedButNotReviewed: Array<{ name: string; reason: string }>;
  tools: ReviewedTool[];
};

/** `ENV MCP_TELEGRAM_ENABLE_X=1` lines of the hosted image's Dockerfile. */
function hostedEnableFlags(): string[] {
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  return [...dockerfile.matchAll(/^ENV\s+(MCP_TELEGRAM_ENABLE_[A-Z_]+)=1\s*$/gm)].map((m) => m[1] as string);
}

const FAKE_DEPS = {
  getTelegram: () => ({}) as TelegramService,
  requireConnection: async () => null,
};

let listed = new Map<string, ListedTool>();
const savedEnv = new Map<string, string | undefined>();

before(async () => {
  // Reproduce the hosted image: only the Dockerfile's opt-in flags, nothing from the developer's shell.
  for (const key of Object.keys(process.env).filter((k) => k.startsWith("MCP_TELEGRAM_ENABLE_"))) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const flag of hostedEnableFlags()) {
    if (!savedEnv.has(flag)) savedEnv.set(flag, process.env[flag]);
    process.env[flag] = "1";
  }

  const server = new McpServer({ name: "reviewed-contract", version: "0.0.0" });
  registerAllTools(server, TOOLS, FAKE_DEPS);
  const client = new Client({ name: "reviewed-contract-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  listed = new Map((tools as ListedTool[]).map((t) => [t.name, t]));
  await client.close();
  await server.close();
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe(`reviewed tool contract (${contract.review})`, () => {
  it("the fixture is well-formed", () => {
    assert.ok(contract.tools.length > 0);
    const names = contract.tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool in the fixture");
  });

  it("every reviewed tool is still served by the hosted image", () => {
    const missing = contract.tools.map((t) => t.name).filter((n) => !listed.has(n));
    assert.deepEqual(
      missing,
      [],
      `reviewed tool(s) removed, renamed or gated off: ${missing.join(", ")}. ` +
        "The reviewer's test cases call these names; restore them or wait for the review decision (#52).",
    );
  });

  it("no tool beyond the reviewed set is served", () => {
    const reviewed = new Set([...contract.tools, ...contract.servedButNotReviewed].map((t) => t.name));
    const extra = [...listed.keys()].filter((n) => !reviewed.has(n)).sort();
    assert.deepEqual(
      extra,
      [],
      `tool(s) not in the reviewed contract: ${extra.join(", ")}. ` +
        "Keep new tools out of the hosted catalog (requiresEnv or not registered) until the review is decided (#52).",
    );
  });

  it("known exceptions are still exceptions", () => {
    // An exception that is now in the snapshot, or no longer served, should be deleted from the list.
    const reviewed = new Set(contract.tools.map((t) => t.name));
    const stale = contract.servedButNotReviewed.map((t) => t.name).filter((n) => reviewed.has(n) || !listed.has(n));
    assert.deepEqual(stale, [], `remove from servedButNotReviewed: ${stale.join(", ")}`);
  });

  it("titles and annotations are unchanged", () => {
    const drift: string[] = [];
    for (const want of contract.tools) {
      const got = listed.get(want.name);
      if (!got) continue;
      if (got.title !== want.title) drift.push(`${want.name}: title "${got.title}" (reviewed "${want.title}")`);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        if (got.annotations?.[hint] !== want.annotations[hint]) {
          drift.push(`${want.name}: ${hint}=${got.annotations?.[hint]} (reviewed ${want.annotations[hint]})`);
        }
      }
    }
    assert.deepEqual(drift, [], `reviewed metadata changed:\n  ${drift.join("\n  ")}`);
  });

  it("arguments stay compatible: same required set, no reviewed argument removed", () => {
    const drift: string[] = [];
    for (const want of contract.tools) {
      const got = listed.get(want.name);
      if (!got) continue;
      const required = [...(got.inputSchema.required ?? [])].sort();
      if (JSON.stringify(required) !== JSON.stringify(want.required)) {
        drift.push(`${want.name}: required [${required.join(", ")}] (reviewed [${want.required.join(", ")}])`);
      }
      const properties = new Set(Object.keys(got.inputSchema.properties ?? {}));
      const removed = want.properties.filter((p) => !properties.has(p));
      if (removed.length > 0) drift.push(`${want.name}: argument(s) removed: ${removed.join(", ")}`);
    }
    assert.deepEqual(drift, [], `reviewed arguments changed:\n  ${drift.join("\n  ")}`);
  });
});
