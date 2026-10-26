/**
 * The annotation contract for every tool in the catalog.
 *
 * MCP hints are how ChatGPT and Claude decide what needs a confirmation, so a
 * wrong one is not cosmetic: `openWorldHint: false` on a tool that delivers a
 * message to another person tells the client the action is contained. This
 * table pins the intended class of all 184 tools, and the last test fails when a
 * new tool is added without a deliberate decision — the failure mode we are
 * guarding against is a tool inheriting a default nobody looked at.
 *
 * Class meanings live in `src/tools/helpers.ts`, following the OpenAI plugin
 * guidelines: destructiveHint is "deletes, overwrites, revokes or sends
 * irreversibly", openWorldHint is "reaches beyond the account's own chats,
 * contacts and settings".
 */
process.env.ISSUER ??= "https://tool-annotation-contract-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { TOOLS } = await import("../tools.js");
const {
  READ_ONLY,
  READ_OPEN,
  LOCAL_WRITE,
  OUTBOUND_WRITE,
  CONFIRMED_WRITE_LOCAL,
  CONFIRMED_WRITE_PUBLIC,
  DESTRUCTIVE_LOCAL,
  DESTRUCTIVE_PUBLIC,
  isGuardedDestructive,
} = await import("../tools/helpers.js");

const CLASSES = {
  READ_ONLY,
  READ_OPEN,
  LOCAL_WRITE,
  OUTBOUND_WRITE,
  CONFIRMED_WRITE_LOCAL,
  CONFIRMED_WRITE_PUBLIC,
  DESTRUCTIVE_LOCAL,
  DESTRUCTIVE_PUBLIC,
} as const;

const EXPECTED: Record<keyof typeof CLASSES, readonly string[]> = {
  READ_ONLY: [
    "telegram-accounts-current",
    "telegram-accounts-list",
    "telegram-download-media",
    "telegram-export-story-link",
    "telegram-get-admin-log",
    "telegram-get-all-stories",
    "telegram-get-available-star-gifts",
    "telegram-get-boosts-list",
    "telegram-get-boosts-status",
    "telegram-get-broadcast-stats",
    "telegram-get-business-chat-links",
    "telegram-get-channel-updates",
    "telegram-get-chat-folders",
    "telegram-get-chat-info",
    "telegram-get-chat-members",
    "telegram-get-contact-requests",
    "telegram-get-contacts",
    "telegram-get-discussion-message",
    "telegram-get-drafts",
    "telegram-get-fact-check",
    "telegram-get-global-privacy-settings",
    "telegram-get-group-call",
    "telegram-get-group-call-participants",
    "telegram-get-groups-for-discussion",
    "telegram-get-installed-stickers",
    "telegram-get-invite-links",
    "telegram-get-megagroup-stats",
    "telegram-get-message-buttons",
    "telegram-get-message-link",
    "telegram-get-message-read-participants",
    "telegram-get-my-boosts",
    "telegram-get-my-role",
    "telegram-get-outbox-read-date",
    "telegram-get-paid-reaction-privacy",
    "telegram-get-poll-results",
    "telegram-get-poll-voters",
    "telegram-get-quick-replies",
    "telegram-get-quick-reply-messages",
    "telegram-get-reactions",
    "telegram-get-recent-reactions",
    "telegram-get-recent-stickers",
    "telegram-get-replies",
    "telegram-get-saved-dialogs",
    "telegram-get-saved-star-gifts",
    "telegram-get-scheduled",
    "telegram-get-sessions",
    "telegram-get-stars-status",
    "telegram-get-stars-subscriptions",
    "telegram-get-stars-topup-options",
    "telegram-get-stars-transactions",
    "telegram-get-state",
    "telegram-get-story-views",
    "telegram-get-suggested-folders",
    "telegram-get-top-reactions",
    "telegram-get-transcription",
    "telegram-get-unread",
    "telegram-get-updates",
    "telegram-list-chats",
    "telegram-list-emoji-statuses",
    "telegram-list-topics",
    "telegram-read-messages",
    "telegram-read-topic-messages",
    "telegram-search-messages",
    "telegram-status",
  ],
  READ_OPEN: [
    "telegram-get-peer-stories",
    "telegram-get-profile",
    "telegram-get-profile-photo",
    "telegram-get-saved-music",
    "telegram-get-sticker-set",
    "telegram-get-stories-archive",
    "telegram-get-stories-by-id",
    "telegram-get-web-preview",
    "telegram-inline-query",
    "telegram-resolve-business-chat-link",
    "telegram-search-chats",
    "telegram-search-global",
    "telegram-search-sticker-sets",
  ],
  LOCAL_WRITE: [
    "telegram-accounts-add",
    "telegram-accounts-switch",
    "telegram-add-contact",
    "telegram-archive-chat",
    "telegram-create-folder",
    "telegram-mark-dialog-unread",
    "telegram-mute-chat",
    "telegram-pin-chat",
    "telegram-rate-transcription",
    "telegram-set-default-reaction",
    "telegram-toggle-folder-tags",
    "telegram-transcribe-audio",
    "telegram-translate-message",
  ],
  OUTBOUND_WRITE: [
    "telegram-create-business-chat-link",
    "telegram-create-invite-link",
    "telegram-create-topic",
    "telegram-join-chat",
    "telegram-save-star-gift",
    "telegram-send-typing",
    "telegram-set-birthday",
    "telegram-toggle-story-pinned",
    "telegram-unban-user",
    "telegram-unblock-user",
  ],
  CONFIRMED_WRITE_LOCAL: [
    "telegram-activate-stealth-mode",
    "telegram-edit-folder",
    "telegram-get-unread-mentions",
    "telegram-get-unread-reactions",
    "telegram-reorder-folders",
    "telegram-save-draft",
    "telegram-set-global-privacy-settings",
    "telegram-set-privacy",
  ],
  CONFIRMED_WRITE_PUBLIC: [
    "telegram-approve-join-request",
    "telegram-block-user",
    "telegram-create-group",
    "telegram-create-poll",
    "telegram-edit-business-chat-link",
    "telegram-edit-fact-check",
    "telegram-edit-group",
    "telegram-edit-message",
    "telegram-edit-topic",
    "telegram-forward-message",
    "telegram-inline-query-send",
    "telegram-invite-to-group",
    "telegram-mark-as-read",
    "telegram-pin-message",
    "telegram-press-button",
    "telegram-react-to-story",
    "telegram-read-stories",
    "telegram-send-album",
    "telegram-send-contact",
    "telegram-send-dice",
    "telegram-send-file",
    "telegram-send-location",
    "telegram-send-message",
    "telegram-send-reaction",
    "telegram-send-scheduled",
    "telegram-send-sticker",
    "telegram-send-story",
    "telegram-send-venue",
    "telegram-send-video-note",
    "telegram-send-voice",
    "telegram-set-admin",
    "telegram-set-business-away",
    "telegram-set-business-greeting",
    "telegram-set-business-hours",
    "telegram-set-business-intro",
    "telegram-set-business-location",
    "telegram-set-emoji-status",
    "telegram-set-personal-channel",
    "telegram-set-profile-color",
    "telegram-set-profile-photo",
    "telegram-set-slow-mode",
    "telegram-toggle-anti-spam",
    "telegram-toggle-channel-signatures",
    "telegram-toggle-paid-reaction-privacy",
    "telegram-toggle-prehistory-hidden",
    "telegram-toggle-story-pinned-to-top",
    "telegram-unpin-message",
    "telegram-update-profile",
    "telegram-vote-poll",
  ],
  DESTRUCTIVE_LOCAL: [
    "telegram-accounts-remove",
    "telegram-clear-drafts",
    "telegram-clear-recent-emoji-statuses",
    "telegram-delete-folder",
    "telegram-delete-scheduled",
  ],
  DESTRUCTIVE_PUBLIC: [
    "telegram-ban-user",
    "telegram-change-stars-subscription",
    "telegram-close-poll",
    "telegram-convert-star-gift",
    "telegram-delete-business-chat-link",
    "telegram-delete-fact-check",
    "telegram-delete-message",
    "telegram-delete-profile-photo",
    "telegram-delete-stories",
    "telegram-delete-topic",
    "telegram-edit-story",
    "telegram-kick-user",
    "telegram-leave-group",
    "telegram-remove-admin",
    "telegram-report-spam",
    "telegram-report-story",
    "telegram-revoke-invite-link",
    "telegram-send-paid-reaction",
    "telegram-set-auto-delete",
    "telegram-set-chat-permissions",
    "telegram-set-chat-reactions",
    "telegram-toggle-forum-mode",
  ],
};

describe("tool annotation contract", () => {
  for (const [className, names] of Object.entries(EXPECTED) as Array<[keyof typeof CLASSES, readonly string[]]>) {
    it(`${names.length} tools are ${className}`, () => {
      const expected = CLASSES[className];
      for (const name of names) {
        const tool = TOOLS.find((t) => t.name === name);
        assert.ok(tool, `${name} is missing from the catalog`);
        if (!tool) continue;
        assert.deepEqual(
          {
            readOnlyHint: tool.annotations.readOnlyHint,
            destructiveHint: tool.annotations.destructiveHint,
            openWorldHint: tool.annotations.openWorldHint,
          },
          { ...expected },
          `${name} should be annotated ${className}`,
        );
      }
    });
  }

  it("every tool in the catalog is classified", () => {
    const classified = new Set(Object.values(EXPECTED).flat());
    const unclassified = TOOLS.map((t) => t.name).filter((n) => !classified.has(n));
    assert.deepEqual(
      unclassified,
      [],
      `new tool(s) without an annotation decision: ${unclassified.join(", ")}. ` +
        "Add them to EXPECTED after choosing a class in src/tools/helpers.ts.",
    );
  });

  it("only deletions go through the destructive opt-in, CONFIRMED_WRITE tools do not", () => {
    for (const name of [...EXPECTED.DESTRUCTIVE_LOCAL, ...EXPECTED.DESTRUCTIVE_PUBLIC]) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool && isGuardedDestructive(tool.annotations), `${name} must be gated by DestructiveGuard`);
    }
    for (const name of [...EXPECTED.CONFIRMED_WRITE_LOCAL, ...EXPECTED.CONFIRMED_WRITE_PUBLIC]) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool?.annotations.destructiveHint, `${name} must advertise destructiveHint`);
      assert.equal(isGuardedDestructive(tool.annotations), false, `${name} must not require the opt-in`);
    }
    // A copied class object loses its identity and must fall back to the gated path.
    assert.equal(isGuardedDestructive({ ...CONFIRMED_WRITE_PUBLIC }), true);
  });

  it("no tool claims to be read-only while also being destructive", () => {
    const contradictory = TOOLS.filter((t) => t.annotations.readOnlyHint && t.annotations.destructiveHint);
    assert.deepEqual(
      contradictory.map((t) => t.name),
      [],
    );
  });

  it("every tool that reaches other people is marked openWorldHint", () => {
    // Spot-check the class of tool the guidance calls out by name: anything
    // that delivers content to a recipient or posts publicly.
    const mustBeOpenWorld = TOOLS.filter(
      (t) => /^telegram-(send|forward|invite|report)-/.test(t.name) && t.name !== "telegram-send-paid-reaction",
    );
    assert.ok(mustBeOpenWorld.length > 0, "expected the filter to match some tools");
    for (const tool of mustBeOpenWorld) {
      assert.equal(tool.annotations.openWorldHint, true, `${tool.name} must be openWorldHint=true`);
    }
  });

  it("every send to other people advertises destructiveHint (an irreversible send)", () => {
    // OpenAI plugin guidelines: destructiveHint covers "irreversible sends";
    // "the user can delete it later" does not justify false. The typing
    // indicator is the one send that leaves nothing behind.
    const sends = TOOLS.filter(
      (t) => /^telegram-(send|forward|invite)-/.test(t.name) && t.name !== "telegram-send-typing",
    );
    assert.ok(sends.length > 10, "expected the filter to match the send tools");
    for (const tool of sends) {
      assert.equal(tool.annotations.destructiveHint, true, `${tool.name} must be destructiveHint=true`);
    }
  });

  it("tools that take precise location, phone numbers or a birth date are opt-in, not hosted by default", () => {
    // OpenAI plugin guidelines: no precise location in input schemas, no
    // sensitive personal data the stated purpose does not strictly need. The
    // hosted image does not set this flag (see the reviewed contract test).
    const personal = [
      "telegram-send-location",
      "telegram-send-venue",
      "telegram-set-business-location",
      "telegram-send-contact",
      "telegram-add-contact",
      "telegram-set-birthday",
    ];
    for (const name of personal) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is missing from the catalog`);
      assert.equal(tool?.requiresEnv, "MCP_TELEGRAM_ENABLE_PERSONAL_DATA", `${name} must be behind the opt-in`);
    }
    const sensitiveField = /^(latitude|longitude|address|phone|birthday|day|month|year|password|code)$/;
    const exposed = TOOLS.filter((t) => !t.requiresEnv)
      .filter((t) => Object.keys(t.inputSchema ?? {}).some((f) => sensitiveField.test(f)))
      .map(
        (t) =>
          `${t.name}(${Object.keys(t.inputSchema ?? {})
            .filter((f) => sensitiveField.test(f))
            .join(",")})`,
      );
    assert.deepEqual(exposed, [], "a default-on tool asks for a restricted or sensitive field");
  });
});
