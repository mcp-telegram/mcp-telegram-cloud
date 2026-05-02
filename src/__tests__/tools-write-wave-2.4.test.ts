// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-write-wave-2.4-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

const { TOOLS } = await import("../tools.js");
const { EXPLICIT_EXCLUDED } = await import("../parity-config.js");

const WAVE_2_4_TOOLS = [
  // Folders + global-privacy write
  "telegram-create-folder",
  "telegram-edit-folder",
  "telegram-delete-folder",
  "telegram-reorder-folders",
  "telegram-toggle-folder-tags",
  "telegram-set-global-privacy-settings",
  // Business writes
  "telegram-create-business-chat-link",
  "telegram-edit-business-chat-link",
  "telegram-delete-business-chat-link",
  "telegram-set-business-hours",
  "telegram-set-business-location",
  "telegram-set-business-greeting",
  "telegram-set-business-away",
  "telegram-set-business-intro",
  // Profile writes
  "telegram-set-emoji-status",
  "telegram-clear-recent-emoji-statuses",
  "telegram-set-profile-color",
  "telegram-set-birthday",
  "telegram-set-personal-channel",
  "telegram-delete-profile-photo",
  "telegram-update-profile",
  "telegram-set-privacy",
  // Misc state-change
  "telegram-set-auto-delete",
  "telegram-add-contact",
  "telegram-approve-join-request",
  "telegram-activate-stealth-mode",
] as const;

const PREMIUM_TOOLS = [
  "telegram-toggle-folder-tags",
  "telegram-set-global-privacy-settings",
  "telegram-set-emoji-status",
  "telegram-set-profile-color",
  "telegram-activate-stealth-mode",
] as const;

const BUSINESS_TOOLS = [
  "telegram-create-business-chat-link",
  "telegram-edit-business-chat-link",
  "telegram-delete-business-chat-link",
  "telegram-set-business-hours",
  "telegram-set-business-location",
  "telegram-set-business-greeting",
  "telegram-set-business-away",
  "telegram-set-business-intro",
] as const;

describe("Wave 2.4 — profile / folders / business writes (non-destructive)", () => {
  for (const name of WAVE_2_4_TOOLS) {
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
        `${name} should have destructiveHint:false (Wave 2.4 is non-destructive; clear-drafts deferred → Phase 2.1)`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("none of the Wave 2.4 tools require an opt-in env flag", () => {
    for (const name of WAVE_2_4_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      if (!tool) continue;
      assert.equal(tool.requiresEnv, undefined, `${name} unexpectedly gated by ${tool.requiresEnv}`);
    }
  });

  it("set-profile-photo is in EXPLICIT_EXCLUDED with FS-bound reason (parity with send-file/voice/etc.)", () => {
    const excluded = EXPLICIT_EXCLUDED.find((e) => e.name === "telegram-set-profile-photo");
    assert.ok(excluded, "set-profile-photo must be in EXPLICIT_EXCLUDED — it's filesystem-bound");
    assert.match(excluded.reason, /absolute path|filesystem/i, "exclusion reason should cite the FS-bound rationale");
    // And NOT in TOOLS:
    const tool = TOOLS.find((t) => t.name === "telegram-set-profile-photo");
    assert.equal(tool, undefined, "set-profile-photo must NOT be exposed");
  });

  describe("PREMIUM error mapping", () => {
    for (const name of PREMIUM_TOOLS) {
      it(`${name} maps PREMIUM_ACCOUNT_REQUIRED to a friendly error`, () => {
        const tool = TOOLS.find((t) => t.name === name);
        assert.ok(tool?.onError, `${name} should have onError`);
        if (!tool?.onError) return;
        const result = tool.onError(new Error("PREMIUM_ACCOUNT_REQUIRED"));
        assert.ok(result, `${name} onError should match PREMIUM_ACCOUNT_REQUIRED`);
        assert.equal(result.isError, true);
        // Unrelated errors fall through (return null) so registry's default handler runs.
        const fallthrough = tool.onError(new Error("UNRELATED_ERROR"));
        assert.equal(fallthrough, null, `${name} onError should return null for unrelated errors`);
      });
    }
  });

  describe("BUSINESS error mapping", () => {
    for (const name of BUSINESS_TOOLS) {
      it(`${name} maps BUSINESS_ACCOUNT_REQUIRED to a friendly error`, () => {
        const tool = TOOLS.find((t) => t.name === name);
        assert.ok(tool?.onError, `${name} should have onError`);
        if (!tool?.onError) return;
        const result = tool.onError(new Error("BUSINESS_ACCOUNT_REQUIRED"));
        assert.ok(result, `${name} onError should match BUSINESS_ACCOUNT_REQUIRED`);
        assert.equal(result.isError, true);
        // Match upstream's "Requires Telegram Business subscription." docstring intent.
        const text =
          "content" in result && Array.isArray(result.content) && result.content[0] && "text" in result.content[0]
            ? (result.content[0].text as string)
            : "";
        assert.match(text, /Telegram Business/, `${name} should mention Telegram Business in the error message`);
      });
    }
  });

  describe("preValidate guards (parity with upstream inline if/throw)", () => {
    it("set-emoji-status: documentId+collectibleId mutually exclusive", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-emoji-status");
      assert.ok(tool?.preValidate);
      const both = tool.preValidate?.({ documentId: "1", collectibleId: "2" });
      assert.ok(both, "both set should reject");
      assert.equal(both?.isError, true);
      assert.equal(tool.preValidate?.({ documentId: "1" }), null);
      assert.equal(tool.preValidate?.({}), null); // empty = clear
    });

    it("set-business-greeting: includeUsers+excludeUsers mutually exclusive", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-business-greeting");
      assert.ok(tool?.preValidate);
      const both = tool.preValidate?.({
        shortcutId: 1,
        includeUsers: ["@a"],
        excludeUsers: ["@b"],
        audience: "all_new",
        noActivityDays: 7,
      });
      assert.ok(both);
      assert.equal(both?.isError, true);
    });

    it("set-business-away: schedule=custom requires customFrom and customTo", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-business-away");
      assert.ok(tool?.preValidate);
      const partial = tool.preValidate?.({
        shortcutId: 1,
        schedule: "custom",
        customFrom: 1,
        offlineOnly: true,
        audience: "all_new",
      });
      assert.ok(partial, "missing customTo should reject");
      assert.equal(partial?.isError, true);
    });

    it("set-business-intro: sticker triple is all-or-nothing", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-business-intro");
      assert.ok(tool?.preValidate);
      const partial = tool.preValidate?.({
        title: "T",
        description: "D",
        stickerId: "1",
      });
      assert.ok(partial, "stickerId without accessHash + fileReference should reject");
      assert.equal(partial?.isError, true);
    });

    it("set-business-hours: timezone+schedule required when not clearing", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-business-hours");
      assert.ok(tool?.preValidate);
      const empty = tool.preValidate?.({});
      assert.ok(empty, "empty args should reject");
      assert.equal(empty?.isError, true);
      assert.equal(tool.preValidate?.({ clear: true }), null);
    });

    it("set-business-location: latitude/longitude must both be set or both omitted", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-business-location");
      assert.ok(tool?.preValidate);
      const half = tool.preValidate?.({ address: "addr", latitude: 1 });
      assert.ok(half, "latitude without longitude should reject");
      assert.equal(half?.isError, true);
    });

    it("set-personal-channel: channelId and clear=true mutually exclusive", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-personal-channel");
      assert.ok(tool?.preValidate);
      const both = tool.preValidate?.({ channelId: "@x", clear: true });
      assert.ok(both);
      assert.equal(both?.isError, true);
      const neither = tool.preValidate?.({});
      assert.ok(neither, "no channelId and no clear should reject");
    });

    it("set-birthday: day+month required when not clearing", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-birthday");
      assert.ok(tool?.preValidate);
      assert.ok(tool.preValidate?.({}), "empty should reject (need day+month)");
      assert.equal(tool.preValidate?.({ clear: true }), null);
    });

    it("activate-stealth-mode: at least one of past/future required", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-activate-stealth-mode");
      assert.ok(tool?.preValidate);
      const empty = tool.preValidate?.({});
      assert.ok(empty);
      assert.equal(empty?.isError, true);
      assert.equal(tool.preValidate?.({ past: true }), null);
      assert.equal(tool.preValidate?.({ future: true }), null);
    });
  });

  describe("Folder schema invariants (parity with upstream)", () => {
    it("create/edit/delete-folder: id must be ≥ 2 (0 = All Chats, 1 = Archive are system)", () => {
      for (const name of ["telegram-edit-folder", "telegram-delete-folder"] as const) {
        const tool = TOOLS.find((t) => t.name === name);
        assert.ok(tool?.inputSchema);
        const schema = z.object(tool.inputSchema as z.ZodRawShape);
        assert.throws(() => schema.parse({ id: 0 }), `${name} should reject id=0`);
        assert.throws(() => schema.parse({ id: 1 }), `${name} should reject id=1`);
        assert.doesNotThrow(() => schema.parse({ id: 2 }), `${name} should accept id=2`);
      }
    });

    it("create-folder: title.max(12) + pinnedPeers.max(5)", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-create-folder");
      assert.ok(tool?.inputSchema);
      const schema = z.object(tool.inputSchema as z.ZodRawShape);
      assert.throws(() => schema.parse({ title: "x".repeat(13) }), "title > 12 chars should reject");
      assert.throws(
        () => schema.parse({ title: "ok", pinnedPeers: ["a", "b", "c", "d", "e", "f"] }),
        "pinnedPeers > 5 should reject",
      );
      assert.doesNotThrow(() => schema.parse({ title: "ok" }));
    });
  });

  describe("set-privacy schema parity", () => {
    it("setting and rule enums match upstream literal values", () => {
      const tool = TOOLS.find((t) => t.name === "telegram-set-privacy");
      assert.ok(tool?.inputSchema);
      const schema = z.object(tool.inputSchema as z.ZodRawShape);
      const validSettings = ["phone_number", "last_seen", "profile_photo", "forwards", "calls", "groups", "bio"];
      for (const setting of validSettings) {
        assert.doesNotThrow(() => schema.parse({ setting, rule: "everyone" }));
      }
      assert.throws(() => schema.parse({ setting: "address", rule: "everyone" }), "unknown setting must reject");
      assert.throws(() => schema.parse({ setting: "phone_number", rule: "friends" }), "unknown rule must reject");
    });
  });
});
