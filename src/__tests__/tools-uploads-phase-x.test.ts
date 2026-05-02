// Validate at import time so config doesn't reject; tools.ts pulls config in transitively.
process.env.ISSUER ??= "https://tools-uploads-phase-x-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

const { TOOLS } = await import("../tools.js");
const { EXPLICIT_EXCLUDED } = await import("../parity-config.js");

const PHASE_X_TOOLS = [
  "telegram-send-file",
  "telegram-send-voice",
  "telegram-send-video-note",
  "telegram-send-album",
  "telegram-send-story",
  "telegram-set-profile-photo",
] as const;

describe("Phase X — FS-bound tools registered with source union", () => {
  for (const name of PHASE_X_TOOLS) {
    it(`registers ${name} as a non-destructive write tool`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) return;
      assert.equal(tool.annotations.readOnlyHint, false, `${name} should not be read-only`);
      assert.equal(
        tool.annotations.destructiveHint,
        false,
        `${name} is non-destructive — content can be deleted by the user via Telegram itself`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("none of the Phase X tools require an opt-in env flag", () => {
    for (const name of PHASE_X_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool);
      if (!tool) continue;
      assert.equal(tool.requiresEnv, undefined, `${name} unexpectedly gated by ${tool.requiresEnv}`);
    }
  });

  it("all Phase X tools accept a `source` field", () => {
    for (const name of PHASE_X_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool?.inputSchema, `${name} missing inputSchema`);
      const shape = tool.inputSchema as Record<string, unknown>;
      // send-album takes `items` array of {source, caption} instead of a top-level source.
      if (name === "telegram-send-album") {
        assert.ok("items" in shape, `${name} should expose 'items' field`);
        continue;
      }
      assert.ok("source" in shape, `${name} should expose 'source' discriminated union`);
    }
  });

  it("source union accepts both 'upload' and 'url' kinds", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-file");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);

    // upload kind
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", source: { kind: "upload", uploadId: "upl_test" } }));
    // url kind
    assert.doesNotThrow(() =>
      schema.parse({ chatId: "@me", source: { kind: "url", url: "https://example.com/file.bin" } }),
    );
    // missing kind
    assert.throws(() => schema.parse({ chatId: "@me", source: { uploadId: "x" } }));
    // invalid url
    assert.throws(() => schema.parse({ chatId: "@me", source: { kind: "url", url: "not a url" } }));
    // empty uploadId
    assert.throws(() => schema.parse({ chatId: "@me", source: { kind: "upload", uploadId: "" } }));
  });

  it("send-album accepts a mixed [upload, url] items array (cross-source)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-album");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    assert.doesNotThrow(() =>
      schema.parse({
        chatId: "@me",
        items: [
          { source: { kind: "upload", uploadId: "upl_a" }, caption: "first" },
          { source: { kind: "url", url: "https://example.com/b.jpg" } },
          { source: { kind: "upload", uploadId: "upl_c" }, caption: "third" },
        ],
      }),
    );
  });

  it("send-video-note caps duration at 60 and length at 640 (parity with upstream send-media.js:40-46)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-video-note");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    const base = { chatId: "@me", source: { kind: "upload" as const, uploadId: "upl_x" } };
    assert.doesNotThrow(() => schema.parse({ ...base, duration: 60 }));
    assert.throws(() => schema.parse({ ...base, duration: 61 }));
    assert.doesNotThrow(() => schema.parse({ ...base, length: 640 }));
    assert.throws(() => schema.parse({ ...base, length: 641 }));
  });

  it("send-story period accepts only the 4 Telegram-blessed lifetimes (upstream stories.js:130)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-story");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    const base = {
      chatId: "me",
      source: { kind: "upload" as const, uploadId: "upl_x" },
      privacy: "everyone" as const,
    };
    for (const p of [21600, 43200, 86400, 172800]) {
      assert.doesNotThrow(() => schema.parse({ ...base, period: p }), `period=${p} should be allowed`);
    }
    assert.throws(() => schema.parse({ ...base, period: 3600 }), /literal|invalid/i);
    assert.throws(() => schema.parse({ ...base, period: 100000 }), /literal|invalid/i);
  });

  it("send-story caption is capped at 2048 chars (upstream stories.js:115)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-story");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    const base = {
      chatId: "me",
      source: { kind: "upload" as const, uploadId: "upl_x" },
      privacy: "everyone" as const,
    };
    assert.doesNotThrow(() => schema.parse({ ...base, caption: "a".repeat(2048) }));
    assert.throws(() => schema.parse({ ...base, caption: "a".repeat(2049) }), /2048|max/i);
  });

  it("send-album validates 2-10 items (mirrors upstream send-media.js:235)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-album");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    const item = { source: { kind: "upload" as const, uploadId: "upl_x" } };

    assert.throws(() => schema.parse({ chatId: "@me", items: [] }), /at least|min|2/i);
    // 1 item is invalid per Telegram (degenerate "album"); upstream rejects with .min(2).
    assert.throws(() => schema.parse({ chatId: "@me", items: [item] }), /at least|min|2/i);
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", items: [item, item] }));
    assert.doesNotThrow(() => schema.parse({ chatId: "@me", items: Array.from({ length: 10 }, () => item) }));
    assert.throws(() => schema.parse({ chatId: "@me", items: Array.from({ length: 11 }, () => item) }), /max|10/i);
  });

  it("send-story preValidate enforces selected→non-empty allowUserIds (parity with edit-story + upstream)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-send-story");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;
    // selected without allowUserIds — denied
    const denied = tool.preValidate({
      chatId: "me",
      source: { kind: "upload", uploadId: "upl_x" },
      privacy: "selected",
    } as never);
    assert.ok(denied?.isError === true, "selected without allowUserIds must short-circuit");
    // selected with allowUserIds — allowed
    const allowed = tool.preValidate({
      chatId: "me",
      source: { kind: "upload", uploadId: "upl_x" },
      privacy: "selected",
      allowUserIds: ["12345"],
    } as never);
    assert.equal(allowed, null);
    // everyone — allowed regardless of allowUserIds
    const ok = tool.preValidate({
      chatId: "me",
      source: { kind: "upload", uploadId: "upl_x" },
      privacy: "everyone",
    } as never);
    assert.equal(ok, null);
  });

  it("set-profile-photo requires source + isVideo + fallback", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-set-profile-photo");
    assert.ok(tool?.inputSchema);
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    const valid = {
      source: { kind: "upload", uploadId: "upl_x" },
      isVideo: false,
      fallback: false,
    };
    assert.doesNotThrow(() => schema.parse(valid));
    // missing isVideo
    assert.throws(() => schema.parse({ source: valid.source, fallback: false }));
    // missing fallback
    assert.throws(() => schema.parse({ source: valid.source, isVideo: false }));
  });

  it("Phase X tools are NOT in EXPLICIT_EXCLUDED (Phase X moved them out)", () => {
    for (const name of PHASE_X_TOOLS) {
      const found = EXPLICIT_EXCLUDED.find((e) => e.name === name);
      assert.equal(found, undefined, `${name} should NOT be in EXPLICIT_EXCLUDED after Phase X`);
    }
  });

  it("EXPLICIT_EXCLUDED is exactly the 3 OAuth/session-lifecycle tools (Phase X moved 6 out)", () => {
    const names = EXPLICIT_EXCLUDED.map((e) => e.name).sort();
    assert.deepEqual(names, ["telegram-login", "telegram-logout", "telegram-terminate-session"]);
  });
});
