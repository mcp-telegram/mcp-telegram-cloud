// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-write-wave-2.2-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

const { TOOLS } = await import("../tools.js");

const WAVE_2_2_TOOLS = [
  "telegram-send-message",
  "telegram-edit-message",
  "telegram-forward-message",
  "telegram-send-typing",
  "telegram-send-location",
  "telegram-send-venue",
  "telegram-send-contact",
  "telegram-send-dice",
  "telegram-send-sticker",
  "telegram-translate-message",
  "telegram-get-unread-mentions",
  "telegram-get-unread-reactions",
] as const;

describe("Wave 2.2 — write tools (messaging core)", () => {
  for (const name of WAVE_2_2_TOOLS) {
    it(`registers ${name} as a non-destructive write tool`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) return;
      assert.equal(
        tool.annotations.readOnlyHint,
        false,
        `${name} should have readOnlyHint:false (it performs a write)`,
      );
      assert.equal(
        tool.annotations.destructiveHint,
        false,
        `${name} should have destructiveHint:false (Wave 2.2 is non-destructive)`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("none of the Wave 2.2 tools require an opt-in env flag", () => {
    for (const name of WAVE_2_2_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      if (!tool) continue;
      assert.equal(tool.requiresEnv, undefined, `${name} unexpectedly gated by ${tool.requiresEnv}`);
    }
  });

  it("send-message accepts an effect ID matching the upstream regex (numeric, ≤19 digits)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-message");
    assert.ok(tool?.inputSchema, "send-message should expose an input schema");
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", text: "hi", effect: "1234567890123456789" }));
    assert.throws(() => schema.parse({ chatId: "@me", text: "hi", effect: "12345678901234567890" }));
    assert.throws(() => schema.parse({ chatId: "@me", text: "hi", effect: "abc" }));
  });

  it("send-typing defaults action to 'typing' (parity with upstream)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-typing");
    assert.ok(tool?.inputSchema, "send-typing should expose an input schema");
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    const parsed = schema.parse({ chatId: "@me" });
    assert.equal((parsed as { action: string }).action, "typing");
  });

  it("send-location validates lat/lon ranges and live-period bounds", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-location");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    assert.throws(() => schema.parse({ chatId: "@me", latitude: 91, longitude: 0 }));
    assert.throws(() => schema.parse({ chatId: "@me", latitude: 0, longitude: -181 }));
    assert.throws(() => schema.parse({ chatId: "@me", latitude: 0, longitude: 0, livePeriod: 30 }));
    assert.throws(() => schema.parse({ chatId: "@me", latitude: 0, longitude: 0, livePeriod: 90000 }));
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", latitude: 0, longitude: 0, livePeriod: 60 }));
  });

  it("send-contact phone regex matches E.164-like format only", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-contact");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", phone: "+15551234567", firstName: "A" }));
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", phone: "12345678", firstName: "A" }));
    assert.throws(() => schema.parse({ chatId: "@me", phone: "12345", firstName: "A" }));
    assert.throws(() => schema.parse({ chatId: "@me", phone: "abc", firstName: "A" }));
    assert.throws(() => schema.parse({ chatId: "@me", phone: "+15551234567", firstName: "" }));
  });

  it("forward-message accepts arbitrary-length messageIds array (parity with upstream — no min)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-forward-message");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    assert.doesNotThrow(() => schema.parse({ fromChatId: "a", toChatId: "b", messageIds: [] }));
    assert.doesNotThrow(() => schema.parse({ fromChatId: "a", toChatId: "b", messageIds: [1, 2, 3] }));
  });

  it("translate-message has a custom onError mapper for PREMIUM-related upstream errors", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-translate-message");
    assert.ok(tool, "translate-message should be registered");
    if (!tool) return;
    assert.ok(typeof tool.onError === "function", "translate-message should define onError");
    if (!tool.onError) return;
    const result = tool.onError(new Error("PREMIUM_ACCOUNT_REQUIRED")) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };
    assert.match(result.content[0].text, /Premium/i);
    assert.equal(result.isError, true);
    assert.equal(tool.onError(new Error("FLOOD_WAIT_x")), null);
  });

  it("send-dice constrains emoji to the upstream allowlist", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-dice");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", emoji: "🎯" }));
    assert.throws(() => schema.parse({ chatId: "@me", emoji: "🤡" }));
    const parsed = schema.parse({ chatId: "@me" });
    assert.equal((parsed as { emoji: string }).emoji, "🎲", "default emoji should be 🎲");
  });

  it("get-unread-mentions/reactions default limit to 20 (parity with upstream — no min/max)", () => {
    for (const name of ["telegram-get-unread-mentions", "telegram-get-unread-reactions"] as const) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool?.inputSchema);
      const schema = z.object(tool.inputSchema as z.ZodRawShape);
      const def = schema.parse({ chatId: "@me" }) as { limit: number };
      assert.equal(def.limit, 20, `${name} default limit should be 20`);
      // Upstream allows arbitrary values (clamped server-side); cloud should not be stricter.
      assert.doesNotThrow(() => schema.parse({ chatId: "@me", limit: 0 }));
      assert.doesNotThrow(() => schema.parse({ chatId: "@me", limit: 500 }));
    }
  });

  it("translate-message rejects garbage toLang values (regex enforces ISO 639-1 / locale parity)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-translate-message");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", messageIds: [1], toLang: "en" }));
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", messageIds: [1], toLang: "pt-BR" }));
    assert.throws(() => schema.parse({ chatId: "@me", messageIds: [1], toLang: "EN" }));
    assert.throws(() => schema.parse({ chatId: "@me", messageIds: [1], toLang: "123" }));
    assert.throws(() => schema.parse({ chatId: "@me", messageIds: [1], toLang: "english" }));
  });

  it("send-message handler sanitizes both `text` and `quoteText` before calling the service", async () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-message");
    assert.ok(tool, "send-message should be registered");
    if (!tool) return;
    const lone = "\uD800"; // unpaired high surrogate
    const calls: { text: string; extra: { quoteText?: string; effect?: string } | undefined }[] = [];
    const fakeTelegram = {
      sendMessage: async (
        _chatId: string,
        text: string,
        _replyTo: number | undefined,
        _parseMode: unknown,
        _topicId: number | undefined,
        extra: { quoteText?: string; effect?: string } | undefined,
      ) => {
        calls.push({ text, extra });
        return { id: 1 };
      },
    };
    await tool.handler(
      { chatId: "@me", text: `hi${lone}`, replyTo: 5, quoteText: `q${lone}`, effect: "1" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for handler invocation
      { telegram: fakeTelegram as any },
    );
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].text.includes(lone), "text must be sanitized (no lone high surrogate)");
    assert.ok(calls[0].extra, "extra should be present when quoteText/effect supplied");
    assert.ok(
      calls[0].extra?.quoteText !== undefined && !calls[0].extra.quoteText.includes(lone),
      "quoteText must be sanitized too",
    );
  });

  it("send-venue handler returns the sanitized title in the response (no dependency on outer wrap)", async () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-venue");
    assert.ok(tool, "send-venue should be registered");
    if (!tool) return;
    const lone = "\uD800";
    const fakeTelegram = {
      sendVenue: async () => ({ id: 42 }),
    };
    const result = (await tool.handler(
      {
        chatId: "@me",
        latitude: 1,
        longitude: 2,
        title: `T${lone}`,
        address: "addr",
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for handler invocation
      { telegram: fakeTelegram as any },
    )) as { content: { type: string; text: string }[] };
    assert.ok(!result.content[0].text.includes(lone), "response text must not contain a lone surrogate");
  });

  it("edit-message handler sanitizes the new text (cloud hardens beyond upstream, which does not)", async () => {
    const tool = TOOLS.find((t) => t.name === "telegram-edit-message");
    assert.ok(tool, "edit-message should be registered");
    if (!tool) return;
    const lone = "\uD800";
    const calls: { text: string }[] = [];
    const fakeTelegram = {
      editMessage: async (_chatId: string, _messageId: number, text: string) => {
        calls.push({ text });
      },
    };
    await tool.handler(
      { chatId: "@me", messageId: 1, text: `new${lone}` },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for handler invocation
      { telegram: fakeTelegram as any },
    );
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].text.includes(lone), "edit-message must sanitize before passing to the service");
  });

  it("WAVE_2_2_TOOLS list is exactly the expected size (drift detector)", () => {
    assert.equal(WAVE_2_2_TOOLS.length, 12, "Wave 2.2 should expose exactly 12 tools");
  });
});
