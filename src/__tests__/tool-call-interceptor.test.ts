// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tool-call-interceptor-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const { buildArgAliases, extractInvalidField, installCallToolInterceptor, normalizeArgs, readValidationError } =
  await import("../tool-call-interceptor.js");
const { ARG_ALIASES } = await import("../tools.js");

/**
 * Guards the fix for the production failure where a client sent
 * `{chatId, message}` to `telegram-send-message`. The MCP SDK rejected it with
 * `expected string, received undefined at text` BEFORE the tool callback ran, so
 * nothing was logged and the user believed the message had been sent.
 */

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

function tool(name: string, inputSchema: Record<string, z.ZodTypeAny>): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema,
    annotations: WRITE,
    handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  } as ToolDefinition;
}

describe("buildArgAliases", () => {
  it("maps message → text for a tool that declares text", () => {
    const aliases = buildArgAliases([tool("send", { chatId: z.string(), text: z.string() })]);
    assert.equal(aliases.get("send")?.get("message"), "text");
  });

  it("does not alias a tool that declares both text and message", () => {
    const aliases = buildArgAliases([tool("both", { text: z.string(), message: z.string() })]);
    assert.equal(aliases.get("both")?.get("message"), undefined);
  });

  it("ignores tools without the canonical field", () => {
    const aliases = buildArgAliases([tool("noText", { chatId: z.string() })]);
    assert.equal(aliases.get("noText"), undefined);
  });

  it("covers the real telegram-send-message catalog entry", () => {
    assert.equal(ARG_ALIASES.get("telegram-send-message")?.get("message"), "text");
    assert.equal(ARG_ALIASES.get("telegram-edit-message")?.get("message"), "text");
  });
});

describe("normalizeArgs", () => {
  const aliases = new Map([["message", "text"]]);

  it("renames the alias onto the canonical key", () => {
    const { args, applied } = normalizeArgs({ chatId: "1", message: "hi" }, aliases);
    assert.deepEqual(args, { chatId: "1", text: "hi" });
    assert.deepEqual(applied, [["message", "text"]]);
  });

  it("leaves an explicit canonical value untouched", () => {
    const { args, applied } = normalizeArgs({ text: "real", message: "stray" }, aliases);
    assert.deepEqual(args, { text: "real", message: "stray" });
    assert.deepEqual(applied, []);
  });

  it("does not mutate the caller's object", () => {
    const input = { chatId: "1", message: "hi" };
    normalizeArgs(input, aliases);
    assert.deepEqual(input, { chatId: "1", message: "hi" });
  });

  it("passes through non-objects and empty alias maps", () => {
    assert.deepEqual(normalizeArgs(undefined, aliases).args, undefined);
    assert.deepEqual(normalizeArgs("str", aliases).args, "str");
    assert.deepEqual(normalizeArgs({ message: "hi" }, undefined).args, { message: "hi" });
  });

  it("treats an explicit undefined canonical key as absent", () => {
    const { args } = normalizeArgs({ text: undefined, message: "hi" }, aliases);
    assert.deepEqual(args, { text: "hi" });
  });
});

describe("extractInvalidField", () => {
  it("pulls the field name out of an SDK validation message", () => {
    const msg =
      "Input validation error: Invalid arguments for tool telegram-send-message: Invalid input: expected string, received undefined at text";
    assert.equal(extractInvalidField(msg), "text");
  });

  it("returns undefined when the message has no trailing field", () => {
    assert.equal(extractInvalidField("something else entirely"), undefined);
  });
});

describe("installCallToolInterceptor", () => {
  function makeServer() {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const seen: unknown[] = [];
    server.registerTool(
      "telegram-send-message",
      { description: "send", inputSchema: { chatId: z.string(), text: z.string() } },
      async (args: unknown) => {
        seen.push(args);
        return { content: [{ type: "text" as const, text: "sent" }] };
      },
    );
    return { server, seen };
  }

  function call(server: McpServer, args: Record<string, unknown>) {
    const handlers = (
      server.server as unknown as { _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<unknown>> }
    )._requestHandlers;
    const handler = handlers.get("tools/call");
    assert.ok(handler, "tools/call handler must exist");
    return handler(
      { method: "tools/call", params: { name: "telegram-send-message", arguments: args } },
      { signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} },
    );
  }

  it("reports success when the handler is present", () => {
    const { server } = makeServer();
    assert.equal(installCallToolInterceptor(server, ARG_ALIASES, {}), true);
  });

  it("lets a message-instead-of-text call through to the handler", async () => {
    const { server, seen } = makeServer();
    installCallToolInterceptor(server, ARG_ALIASES, { client: "Test" });

    const result = (await call(server, { chatId: "42", message: "hello" })) as { isError?: boolean };

    assert.notEqual(result.isError, true);
    assert.deepEqual(seen, [{ chatId: "42", text: "hello" }]);
  });

  it("still rejects a call that is invalid for real", async () => {
    const { server, seen } = makeServer();
    installCallToolInterceptor(server, ARG_ALIASES, {});

    // The SDK converts its own InvalidParams into an isError RESULT rather than throwing,
    // which is exactly why `readValidationError` inspects the result instead of catching.
    const result = (await call(server, { chatId: "42" })) as { isError?: boolean };

    assert.equal(result.isError, true);
    assert.deepEqual(seen, [], "handler must not run for a schema-invalid call");
    assert.equal(extractInvalidField(readValidationError(result) ?? ""), "text");
  });

  it("leaves a well-formed call byte-identical", async () => {
    const { server, seen } = makeServer();
    installCallToolInterceptor(server, ARG_ALIASES, {});

    await call(server, { chatId: "42", text: "hello" });

    assert.deepEqual(seen, [{ chatId: "42", text: "hello" }]);
  });

  it("degrades to false when no tools/call handler exists", () => {
    const bare = new McpServer({ name: "bare", version: "0.0.0" });
    assert.equal(installCallToolInterceptor(bare, ARG_ALIASES, {}), false);
  });
});
