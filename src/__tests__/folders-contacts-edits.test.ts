// `src/config.ts` validates env at import time; tools.ts pulls it in transitively.
process.env.ISSUER ??= "https://folders-contacts-edits-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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

describe("add-contact (by username or ID, no phone number)", () => {
  const chatInfo = (over: Record<string, unknown>) => async () => ({
    id: "42",
    name: "Bob",
    type: "private",
    isBot: false,
    isContact: false,
    ...over,
  });
  // Свежий список контактов из Telegram (getChatInfo может отдавать устаревший isContact)
  const contactsOf =
    (...ids: string[]) =>
    async () =>
      ids.map((id) => ({ id, name: `User ${id}` }));

  it("is on with the contact edits, takes no phone and is not a guarded destructive tool", async () => {
    const t = tool("telegram-add-contact");
    assert.equal(t.requiresEnv, "MCP_TELEGRAM_ENABLE_CONTACT_EDITS");
    assert.deepEqual(Object.keys(t.inputSchema ?? {}).sort(), ["firstName", "lastName", "userId"]);
    assert.equal(t.annotations.destructiveHint, false);
    const { isGuardedDestructive } = await import("../tools/helpers.js");
    assert.equal(isGuardedDestructive(t.annotations), false);
  });

  it("adds a non-contact without passing a phone number", async () => {
    let args: unknown[] = [];
    const telegram = {
      getChatInfo: chatInfo({}),
      getContacts: contactsOf("7"),
      addContact: async (...a: unknown[]) => {
        args = a;
      },
    } as unknown as TelegramService;
    const r = await tool("telegram-add-contact").handler({ userId: "@bob", firstName: "Bob", lastName: "Partner" }, {
      telegram,
    } as never);
    // Запись по проверенному ID, а не по исходной строке
    assert.deepEqual(args, ["42", "Bob", "Partner"]);
    assert.equal(text(r), "Contact added: Bob Partner (42)");
  });

  it("two parallel adds of the same user: one adds, the other is refused instead of renaming", async () => {
    const book: string[] = [];
    const calls: unknown[][] = [];
    const telegram = {
      getChatInfo: chatInfo({}),
      // Снимок на момент запроса, ответ с задержкой: без очереди оба вызова увидят пустой список
      getContacts: async () => {
        const snapshot = book.map((id) => ({ id, name: `User ${id}` }));
        await new Promise((r) => setTimeout(r, 5));
        return snapshot;
      },
      addContact: async (...a: unknown[]) => {
        calls.push(a);
        book.push("42");
      },
    } as unknown as TelegramService;
    const run = (firstName: string) =>
      tool("telegram-add-contact").handler({ userId: "@bob", firstName }, { telegram } as never) as Promise<{
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      }>;
    const results = await Promise.all([run("Bob"), run("Robert")]);
    assert.equal(calls.length, 1, "only one AddContact may reach Telegram");
    assert.deepEqual(results.map((r) => Boolean(r.isError)).sort(), [false, true]);
  });

  describe("bounded waits inside the per-account queue", () => {
    let saved = { lookupMs: 0, writeMs: 0, callBudgetMs: 0, inFlightMs: 0 };
    beforeEach(async () => {
      const { ADD_CONTACT_DEADLINES } = await import("../tools/profile.js");
      saved = { ...ADD_CONTACT_DEADLINES };
      Object.assign(ADD_CONTACT_DEADLINES, { lookupMs: 20, writeMs: 20, callBudgetMs: 0, inFlightMs: 60_000 });
    });
    afterEach(async () => {
      const { ADD_CONTACT_DEADLINES } = await import("../tools/profile.js");
      Object.assign(ADD_CONTACT_DEADLINES, saved);
    });
    type R = { isError?: boolean; content: Array<{ type: string; text?: string }> };
    const call = (telegram: TelegramService, firstName = "Bob", extra: Record<string, unknown> = {}) =>
      tool("telegram-add-contact").handler({ userId: "@bob", firstName }, {
        telegram,
        ...extra,
      } as never) as Promise<R>;
    // Запись, которая висит, пока тест не завершит её сам
    const hangingBook = () => {
      const book: string[] = [];
      const state = { writes: 0, finish: () => {} };
      const make = () =>
        ({
          getChatInfo: chatInfo({}),
          getContacts: async () => book.map((id) => ({ id, name: `User ${id}` })),
          addContact: () => {
            state.writes++;
            return new Promise<void>((resolve) => {
              state.finish = () => {
                book.push("42");
                resolve();
              };
            });
          },
        }) as unknown as TelegramService;
      return { state, make };
    };

    it("a hung lookup times out and does not block the next add", async () => {
      let hang = true;
      let added = 0;
      const telegram = {
        getChatInfo: () => (hang ? new Promise(() => {}) : chatInfo({})()),
        getContacts: contactsOf(),
        addContact: async () => {
          added++;
        },
      } as unknown as TelegramService;
      await assert.rejects(call(telegram), /deadline/);
      hang = false;
      const r = await call(telegram);
      assert.equal(r.isError, undefined);
      assert.equal(added, 1);
    });

    it("a hung write goes to the registry as a timeout and a repeat add waits for it instead of renaming", async () => {
      const { state, make } = hangingBook();
      const telegram = make();
      await assert.rejects(call(telegram, "Bob"), /deadline/);
      const repeat = await call(telegram, "Robert");
      assert.equal(repeat.isError, true);
      assert.match(text(repeat), /has not finished yet/);
      state.finish();
      await new Promise((r) => setTimeout(r, 0));
      assert.match(text(await call(telegram, "Robert")), /already in your contacts/);
      assert.equal(state.writes, 1, "the repeat add must never reach Telegram");
    });

    it("the in-flight mark survives a rebuilt client of the same account", async () => {
      const { state, make } = hangingBook();
      const account = { userId: "u-rebuild", sourceAccountId: 0 };
      await assert.rejects(call(make(), "Bob", account), /deadline/);
      // Реестр после таймаута отдаёт новый объект клиента того же аккаунта
      const repeat = await call(make(), "Robert", account);
      assert.match(text(repeat), /has not finished yet/);
      assert.equal(state.writes, 1);
    });

    it("an in-flight mark expires, so a write that never settles does not block the user forever", async () => {
      const { ADD_CONTACT_DEADLINES } = await import("../tools/profile.js");
      ADD_CONTACT_DEADLINES.inFlightMs = 30;
      const { state, make } = hangingBook();
      const telegram = make();
      await assert.rejects(call(telegram, "Bob"), /deadline/);
      await new Promise((r) => setTimeout(r, 40));
      await assert.rejects(call(telegram, "Robert"), /deadline/);
      assert.equal(state.writes, 2);
    });

    it("an expired mark of a write that never settles is removed, not kept forever", async () => {
      const { ADD_CONTACT_DEADLINES, addContactPendingCount } = await import("../tools/profile.js");
      ADD_CONTACT_DEADLINES.inFlightMs = 30;
      const { make } = hangingBook();
      const account = { userId: "u-expiry", sourceAccountId: 0 };
      await assert.rejects(call(make(), "Bob", account), /deadline/);
      assert.equal(addContactPendingCount("u-expiry", 0), 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(addContactPendingCount("u-expiry", 0), 0);
    });

    it("a call whose budget ran out in the queue never reaches Telegram", async () => {
      const { ADD_CONTACT_DEADLINES } = await import("../tools/profile.js");
      // Бюджет вызова 15 мс (плюс секунда запаса): первый поиск висит до него, второму времени не остаётся
      ADD_CONTACT_DEADLINES.callBudgetMs = 1_015;
      let lookups = 0;
      const telegram = {
        getChatInfo: () => {
          lookups++;
          return new Promise(() => {});
        },
        getContacts: contactsOf(),
        addContact: async () => {},
      } as unknown as TelegramService;
      const first = call(telegram, "Bob");
      const second = call(telegram, "Robert");
      await assert.rejects(first, /deadline/);
      assert.match(text(await second), /Ran out of time before adding the contact; nothing was changed/);
      assert.equal(lookups, 1);
    });

    it("no write starts once the call budget is spent, even if the lookups returned", async () => {
      const { ADD_CONTACT_DEADLINES } = await import("../tools/profile.js");
      ADD_CONTACT_DEADLINES.callBudgetMs = 60_000;
      const realNow = Date.now;
      let writes = 0;
      const telegram = {
        getChatInfo: chatInfo({}),
        // Список вернулся, но часы уже за концом бюджета вызова
        getContacts: async () => {
          Date.now = () => realNow() + 120_000;
          return [];
        },
        addContact: async () => {
          writes++;
        },
      } as unknown as TelegramService;
      try {
        assert.match(text(await call(telegram)), /nothing was changed/);
      } finally {
        Date.now = realNow;
      }
      assert.equal(writes, 0);
    });
  });

  it("adds a user that a stale cache still shows as a contact after removal", async () => {
    let called = false;
    const telegram = {
      getChatInfo: chatInfo({ isContact: true }),
      getContacts: contactsOf("7"),
      addContact: async () => {
        called = true;
      },
    } as unknown as TelegramService;
    const r = await tool("telegram-add-contact").handler({ userId: "@bob", firstName: "Bob" }, {
      telegram,
    } as never);
    assert.equal(called, true);
    assert.equal(text(r), "Contact added: Bob (42)");
  });

  for (const [label, over, contactIds, expected] of [
    ["an existing contact", { isContact: true }, ["42"], /already in your contacts; use telegram-rename-contact/],
    [
      "a contact that a stale cache still shows as a non-contact",
      { isContact: false },
      ["42"],
      /already in your contacts; use telegram-rename-contact/,
    ],
    ["a bot", { isBot: true }, [], /is a bot/],
    ["a group or channel", { type: "group" }, [], /is not a user/],
  ] as const) {
    it(`refuses ${label} and never calls addContact`, async () => {
      let called = false;
      const telegram = {
        getChatInfo: chatInfo(over),
        getContacts: contactsOf(...contactIds),
        addContact: async () => {
          called = true;
        },
      } as unknown as TelegramService;
      const r = (await tool("telegram-add-contact").handler({ userId: "@x", firstName: "X" }, {
        telegram,
      } as never)) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      assert.equal(called, false);
      assert.equal(r.isError, true);
      assert.match(text(r), expected);
    });
  }
});
