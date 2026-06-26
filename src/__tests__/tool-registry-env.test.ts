// `src/config.ts` validates env at import time; it is transitively pulled in
// by `tool-registry.ts` via `logger.ts`. Stub env BEFORE any source-tree import.
process.env.ISSUER ??= "https://tool-registry-env-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { ToolDefinition } from "../tool-registry.js";

const { registerAllTools } = await import("../tool-registry.js");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "telegram-test-tool",
    description: "test tool",
    annotations: READ_ONLY,
    skipRequireConnection: true,
    handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    ...overrides,
  };
}

function makeServer(): { server: McpServer; registered: Set<string>; titles: Map<string, unknown> } {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const registered = new Set<string>();
  const titles = new Map<string, unknown>();
  const original = server.registerTool.bind(server);
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    registered.add(name);
    titles.set(name, (rest[0] as { title?: unknown } | undefined)?.title);
    // biome-ignore lint/suspicious/noExplicitAny: relaying SDK call as-is
    return original(name, ...(rest as [any, any]));
  }) as typeof server.registerTool;
  return { server, registered, titles };
}

const FAKE_DEPS = {
  getTelegram: () => ({}) as TelegramService,
  requireConnection: async () => null,
};

describe("tool-registry requiresEnv", () => {
  it("registers a tool with no requiresEnv unconditionally", () => {
    const { server, registered } = makeServer();
    registerAllTools(server, [makeTool({ name: "telegram-no-env" })], FAKE_DEPS);
    assert.ok(registered.has("telegram-no-env"));
  });

  it("skips a tool when its requiresEnv var is not set", () => {
    delete process.env.MCP_TELEGRAM_ENABLE_TEST_FLAG;
    const { server, registered } = makeServer();
    registerAllTools(
      server,
      [makeTool({ name: "telegram-gated", requiresEnv: "MCP_TELEGRAM_ENABLE_TEST_FLAG" })],
      FAKE_DEPS,
    );
    assert.ok(!registered.has("telegram-gated"), "gated tool registered without env=1");
  });

  it("skips a tool when its requiresEnv var is set to something other than '1'", () => {
    process.env.MCP_TELEGRAM_ENABLE_TEST_FLAG = "true";
    try {
      const { server, registered } = makeServer();
      registerAllTools(
        server,
        [makeTool({ name: "telegram-gated", requiresEnv: "MCP_TELEGRAM_ENABLE_TEST_FLAG" })],
        FAKE_DEPS,
      );
      assert.ok(!registered.has("telegram-gated"), "gated tool registered with env='true' (should require '1')");
    } finally {
      delete process.env.MCP_TELEGRAM_ENABLE_TEST_FLAG;
    }
  });

  it("registers a tool when its requiresEnv var is set to '1'", () => {
    process.env.MCP_TELEGRAM_ENABLE_TEST_FLAG = "1";
    try {
      const { server, registered } = makeServer();
      registerAllTools(
        server,
        [makeTool({ name: "telegram-gated", requiresEnv: "MCP_TELEGRAM_ENABLE_TEST_FLAG" })],
        FAKE_DEPS,
      );
      assert.ok(registered.has("telegram-gated"));
    } finally {
      delete process.env.MCP_TELEGRAM_ENABLE_TEST_FLAG;
    }
  });
});

describe("tool-registry title", () => {
  it("derives a title from the tool name when none is given", () => {
    const { server, titles } = makeServer();
    registerAllTools(server, [makeTool({ name: "telegram-send-message" })], FAKE_DEPS);
    assert.equal(titles.get("telegram-send-message"), "Send Message");
  });

  it("passes an explicit title through unchanged", () => {
    const { server, titles } = makeServer();
    registerAllTools(server, [makeTool({ name: "telegram-set-2fa", title: "Set 2FA Password" })], FAKE_DEPS);
    assert.equal(titles.get("telegram-set-2fa"), "Set 2FA Password");
  });
});
