// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tool-registry-destructive-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { registerAllTools } = await import("../tool-registry.js");
const { DESTRUCTIVE, READ_ONLY, WRITE, textResult } = await import("../tools/helpers.js");

interface CallableTool {
  callback: (args: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

interface Call {
  tool: string;
  args: unknown;
  result?: "ok" | "error";
}

/** Wraps `server.registerTool` to capture the SDK callback so the test can invoke
 * it directly (the SDK doesn't expose a public way to dispatch a tool by name). */
function makeServerWithCallbackCapture(): {
  server: McpServer;
  callbacks: Map<string, CallableTool["callback"]>;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const callbacks = new Map<string, CallableTool["callback"]>();
  const original = server.registerTool.bind(server);
  // biome-ignore lint/suspicious/noExplicitAny: SDK signature is overloaded; we capture+relay only.
  (server as any).registerTool = (name: string, config: unknown, callback: CallableTool["callback"]) => {
    callbacks.set(name, callback);
    return original(name, config as never, callback as never);
  };
  return { server, callbacks };
}

function buildHarness() {
  const { server, callbacks } = makeServerWithCallbackCapture();
  const checkCalls: Call[] = [];
  const recordCalls: Call[] = [];

  registerAllTools(
    server,
    [
      {
        name: "destructive-tool",
        description: "destructive test tool with destructiveHint=true",
        annotations: DESTRUCTIVE,
        skipRequireConnection: true,
        handler: async () => textResult("ran destructive"),
      },
      {
        name: "write-tool",
        description: "write test tool with destructiveHint=false",
        annotations: WRITE,
        skipRequireConnection: true,
        handler: async () => textResult("ran write"),
      },
      {
        name: "read-tool",
        description: "read-only test tool",
        annotations: READ_ONLY,
        skipRequireConnection: true,
        handler: async () => textResult("ran read"),
      },
      {
        name: "destructive-erroring-tool",
        description: "destructive tool whose handler returns isError=true",
        annotations: DESTRUCTIVE,
        skipRequireConnection: true,
        handler: async () => ({ content: [{ type: "text" as const, text: "boom" }], isError: true }),
      },
    ],
    {
      getTelegram: () => ({}) as TelegramService,
      requireConnection: async () => null,
      checkDestructive: (tool, args) => {
        checkCalls.push({ tool, args });
        return null; // allow through
      },
      recordDestructive: (tool, args, result) => {
        recordCalls.push({ tool, args, result });
      },
    },
  );

  return { callbacks, checkCalls, recordCalls };
}

describe("tool-registry — destructive guard wiring", () => {
  it("calls checkDestructive only for destructiveHint=true tools", async () => {
    const h = buildHarness();
    await h.callbacks.get("read-tool")?.({});
    await h.callbacks.get("write-tool")?.({});
    await h.callbacks.get("destructive-tool")?.({ chatId: "@x" });

    assert.equal(h.checkCalls.length, 1, "checkDestructive should fire exactly once (for destructive-tool)");
    assert.equal(h.checkCalls[0].tool, "destructive-tool");
    assert.deepEqual(h.checkCalls[0].args, { chatId: "@x" });
  });

  it("calls recordDestructive with 'ok' on successful destructive handler", async () => {
    const h = buildHarness();
    await h.callbacks.get("destructive-tool")?.({ chatId: "@y" });
    assert.equal(h.recordCalls.length, 1);
    assert.equal(h.recordCalls[0].tool, "destructive-tool");
    assert.equal(h.recordCalls[0].result, "ok");
  });

  it("calls recordDestructive with 'error' when handler returns isError:true", async () => {
    const h = buildHarness();
    await h.callbacks.get("destructive-erroring-tool")?.({ chatId: "@z" });
    assert.equal(h.recordCalls.length, 1);
    assert.equal(h.recordCalls[0].result, "error");
  });

  it("never calls recordDestructive for non-destructive tools", async () => {
    const h = buildHarness();
    await h.callbacks.get("write-tool")?.({});
    await h.callbacks.get("read-tool")?.({});
    assert.equal(h.recordCalls.length, 0);
  });

  it("short-circuits with the guard's error message when checkDestructive denies", async () => {
    const { server, callbacks } = makeServerWithCallbackCapture();
    let handlerRan = false;
    let recordCalled = false;
    registerAllTools(
      server,
      [
        {
          name: "destructive-denied",
          description: "destructive tool whose guard denies",
          annotations: DESTRUCTIVE,
          skipRequireConnection: true,
          handler: async () => {
            handlerRan = true;
            return textResult("should never run");
          },
        },
      ],
      {
        getTelegram: () => ({}) as TelegramService,
        requireConnection: async () => null,
        checkDestructive: () => "destructive tools are disabled",
        recordDestructive: () => {
          recordCalled = true;
        },
      },
    );

    const result = await callbacks.get("destructive-denied")?.({});

    assert.equal(handlerRan, false, "handler must not run after deny");
    assert.equal(
      recordCalled,
      false,
      "recordDestructive must not be called when checkDestructive denies — preflight() wrote its own audit row",
    );
    assert.ok(result, "expected a CallToolResult");
    if (!result) return;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /disabled/i);
  });
});
