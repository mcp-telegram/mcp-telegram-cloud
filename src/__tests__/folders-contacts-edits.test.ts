// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://folders-contacts-edits-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";

const { TOOLS } = await import("../tools.js");

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `${name} missing`);
  return t;
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? "";

describe("folder contents", () => {
  it("get-chat-folders with folderId returns the folder's chats", async () => {
    const telegram = {
      getChatFolder: async (id: number) => ({
        id,
        title: "Family",
        shared: false,
        flags: {
          contacts: false,
          nonContacts: false,
          groups: true,
          broadcasts: false,
          bots: false,
          excludeMuted: false,
          excludeRead: false,
          excludeArchived: false,
        },
        pinnedPeers: [],
        includePeers: [{ id: "11", name: "Anna" }],
        excludePeers: [],
      }),
    } as unknown as TelegramService;
    const r = await tool("telegram-get-chat-folders").handler({ folderId: 2 }, { telegram } as never);
    assert.match(text(r), /Type filters: groups/);
    assert.match(text(r), /Included chats \(1\):\n- Anna \(11\)/);
  });

  it("edit-folder passes addPeers/removePeers through and reports the outcome", async () => {
    let seen: unknown;
    const telegram = {
      editFolder: async (_id: number, opts: unknown) => {
        seen = opts;
        return { added: 1, removed: 0, excluded: [], alreadyIncluded: ["@anna"], notInFolder: [] };
      },
    } as unknown as TelegramService;
    const r = await tool("telegram-edit-folder").handler({ id: 2, addPeers: ["@bob", "@anna"] }, {
      telegram,
    } as never);
    assert.deepEqual((seen as { addPeers: string[] }).addPeers, ["@bob", "@anna"]);
    assert.match(text(r), /Added chats: 1\nAlready in the folder: @anna/);
  });
});

describe("contact edits", () => {
  it("rename and delete sit behind the CONTACT_EDITS opt-in flag", () => {
    for (const name of ["telegram-rename-contact", "telegram-delete-contact"]) {
      assert.equal(tool(name).requiresEnv, "MCP_TELEGRAM_ENABLE_CONTACT_EDITS", name);
    }
  });

  it("delete-contact goes through the destructive guard, rename does not", async () => {
    const { isGuardedDestructive } = await import("../tools/helpers.js");
    assert.equal(isGuardedDestructive(tool("telegram-delete-contact").annotations), true);
    assert.equal(isGuardedDestructive(tool("telegram-rename-contact").annotations), false);
  });

  it("rename-contact sends the new name and shows the old one", async () => {
    let args: unknown[] = [];
    const telegram = {
      renameContact: async (...a: unknown[]) => {
        args = a;
        return { id: "11", previousName: "Anna S" };
      },
    } as unknown as TelegramService;
    const r = await tool("telegram-rename-contact").handler({ userId: "@anna", firstName: "Mom" }, {
      telegram,
    } as never);
    assert.deepEqual(args.slice(0, 2), ["@anna", "Mom"]);
    assert.equal(text(r), 'Contact 11 renamed: "Anna S" -> "Mom"');
  });
});
