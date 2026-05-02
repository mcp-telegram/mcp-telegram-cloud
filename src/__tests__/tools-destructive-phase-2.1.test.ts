// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://tools-destructive-phase-2-1-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { TOOLS } = await import("../tools.js");
const { EXPLICIT_EXCLUDED } = await import("../parity-config.js");

const DESTRUCTIVE_TOOLS = [
  "telegram-clear-drafts",
  "telegram-delete-fact-check",
  "telegram-delete-message",
  "telegram-delete-scheduled",
  "telegram-delete-stories",
  "telegram-delete-topic",
  "telegram-edit-story",
  "telegram-revoke-invite-link",
  "telegram-set-chat-permissions",
  "telegram-set-chat-reactions",
  "telegram-toggle-forum-mode",
] as const;

describe("Phase 2.1 destructive — 11 tools registered with destructiveHint=true", () => {
  for (const name of DESTRUCTIVE_TOOLS) {
    it(`registers ${name} with DESTRUCTIVE annotation`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is not in TOOLS array`);
      if (!tool) return;
      assert.equal(tool.annotations.readOnlyHint, false, `${name} must NOT be READ_ONLY`);
      assert.equal(tool.annotations.destructiveHint, true, `${name} must be DESTRUCTIVE`);
      assert.equal(tool.annotations.openWorldHint, false, `${name} must have openWorldHint=false`);
      assert.equal(
        tool.requiresEnv,
        undefined,
        `${name} must NOT be env-gated — gating is handled per-user via DestructiveGuard, not via global env flag`,
      );
      assert.ok(tool.description.length >= 20, `${name} description too short`);
      assert.ok(typeof tool.handler === "function", `${name} missing handler`);
    });
  }

  it("none of the destructive tools are in EXPLICIT_EXCLUDED", () => {
    for (const name of DESTRUCTIVE_TOOLS) {
      const excluded = EXPLICIT_EXCLUDED.find((e) => e.name === name);
      assert.equal(excluded, undefined, `${name} is now exposed via Phase 2.1 and must NOT be in EXPLICIT_EXCLUDED`);
    }
  });

  it("counts exactly 11 destructive tools across the catalog (no accidental extras or omissions)", () => {
    const destructiveInCatalog = TOOLS.filter((t) => t.annotations.destructiveHint === true);
    assert.equal(
      destructiveInCatalog.length,
      DESTRUCTIVE_TOOLS.length,
      `expected exactly ${DESTRUCTIVE_TOOLS.length} destructive tools, got ${destructiveInCatalog.length}: ${destructiveInCatalog
        .map((t) => t.name)
        .join(", ")}`,
    );
    const names = destructiveInCatalog.map((t) => t.name).sort();
    assert.deepEqual(names, [...DESTRUCTIVE_TOOLS].sort());
  });

  it("clear-drafts preValidate enforces chatId XOR confirmAllChats", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-clear-drafts");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;

    // Both chatId and confirmAllChats=true → reject (cloud disambiguates).
    const both = tool.preValidate({ chatId: "@foo", confirmAllChats: true } as never);
    assert.ok(both?.isError, "expected error when both chatId and confirmAllChats=true provided");

    // Neither → reject.
    const neither = tool.preValidate({} as never);
    assert.ok(neither?.isError, "expected error when neither chatId nor confirmAllChats provided");

    // chatId only → accept.
    const chatOnly = tool.preValidate({ chatId: "@foo" } as never);
    assert.equal(chatOnly, null);

    // confirmAllChats=true only → accept.
    const confirmOnly = tool.preValidate({ confirmAllChats: true } as never);
    assert.equal(confirmOnly, null);
  });

  it("toggle-forum-mode preValidate requires confirm=true when disabling", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-toggle-forum-mode");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;

    // Disable without confirm → reject.
    const noConfirm = tool.preValidate({ chatId: "@x", enabled: false } as never);
    assert.ok(noConfirm?.isError, "expected error when disabling without confirm=true");

    // Disable with confirm → accept.
    const withConfirm = tool.preValidate({ chatId: "@x", enabled: false, confirm: true } as never);
    assert.equal(withConfirm, null);

    // Enable always accepted (no confirm needed).
    const enableNoConfirm = tool.preValidate({ chatId: "@x", enabled: true } as never);
    assert.equal(enableNoConfirm, null);
  });

  it("set-chat-permissions preValidate requires at least one permission flag", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-set-chat-permissions");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;

    const empty = tool.preValidate({ chatId: "@x" } as never);
    assert.ok(empty?.isError, "expected error when no permission flag provided");

    const withFlag = tool.preValidate({ chatId: "@x", sendMessages: false } as never);
    assert.equal(withFlag, null);
  });

  it("edit-story preValidate requires at least one of caption|privacy", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-edit-story");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;

    const empty = tool.preValidate({ chatId: "me", storyId: 42 } as never);
    assert.ok(empty?.isError, "expected error when neither caption nor privacy provided");

    const captionOnly = tool.preValidate({ chatId: "me", storyId: 42, caption: "" } as never);
    assert.equal(captionOnly, null);

    const privacyOnly = tool.preValidate({ chatId: "me", storyId: 42, privacy: "contacts" } as never);
    assert.equal(privacyOnly, null);
  });

  it("edit-story preValidate rejects privacy='selected' without a non-empty allowUserIds (parity with upstream)", () => {
    const tool = TOOLS.find((t) => t.name === "telegram-edit-story");
    assert.ok(tool?.preValidate);
    if (!tool?.preValidate) return;

    const noAllow = tool.preValidate({ chatId: "me", storyId: 1, privacy: "selected" } as never);
    assert.ok(noAllow?.isError, "expected error for selected without allowUserIds");

    const emptyAllow = tool.preValidate({ chatId: "me", storyId: 1, privacy: "selected", allowUserIds: [] } as never);
    assert.ok(emptyAllow?.isError, "expected error for selected with empty allowUserIds");

    const ok = tool.preValidate({
      chatId: "me",
      storyId: 1,
      privacy: "selected",
      allowUserIds: ["12345"],
    } as never);
    assert.equal(ok, null);
  });
});
