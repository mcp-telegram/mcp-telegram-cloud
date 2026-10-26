/**
 * Rewrites src/__tests__/fixtures/reviewed-tool-contract.json from the catalog the
 * hosted image serves (real registry, the Dockerfile's MCP_TELEGRAM_ENABLE_* flags,
 * the SDK's own tools/list). Run it only in the PR that prepares a new directory
 * submission: `bun scripts/capture-reviewed-contract.ts "<review label>"`.
 */
process.env.ISSUER ??= "https://capture-reviewed-contract.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const review = process.argv[2];
if (!review) {
  console.error('usage: bun scripts/capture-reviewed-contract.ts "<review label>"');
  process.exit(1);
}

for (const key of Object.keys(process.env).filter((k) => k.startsWith("MCP_TELEGRAM_ENABLE_"))) delete process.env[key];
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
for (const m of dockerfile.matchAll(/^ENV\s+(MCP_TELEGRAM_ENABLE_[A-Z_]+)=1\s*$/gm)) process.env[m[1] as string] = "1";

const { registerAllTools } = await import("../src/tool-registry.js");
const { TOOLS } = await import("../src/tools.js");
const server = new McpServer({ name: "capture-reviewed-contract", version: "0.0.0" });
registerAllTools(server, TOOLS, { getTelegram: () => ({}) as TelegramService, requireConnection: async () => null });
const client = new Client({ name: "capture-reviewed-contract", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const { tools } = await client.listTools();
await client.close();
await server.close();

const path = new URL("../src/__tests__/fixtures/reviewed-tool-contract.json", import.meta.url);
const previous = JSON.parse(readFileSync(path, "utf8"));
const fixture = {
  $comment: previous.$comment,
  review,
  capturedAt: new Date().toISOString().slice(0, 10),
  source:
    "tools/list of the hosted image: real registry, Dockerfile MCP_TELEGRAM_ENABLE_* flags, in-memory transport (scripts/capture-reviewed-contract.ts)",
  servedButNotReviewed: [],
  tools: [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      title: t.title ?? "",
      annotations: {
        readOnlyHint: t.annotations?.readOnlyHint === true,
        destructiveHint: t.annotations?.destructiveHint === true,
        openWorldHint: t.annotations?.openWorldHint === true,
      },
      required: [...(t.inputSchema.required ?? [])].sort(),
      properties: Object.keys(t.inputSchema.properties ?? {}).sort(),
    })),
};
writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`captured ${fixture.tools.length} tools for "${review}"`);
