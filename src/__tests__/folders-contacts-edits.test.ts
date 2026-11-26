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
  // Точечная свежая проверка одного пользователя (users.GetUsers в ядре)
  const statusOf =
    (over: Record<string, unknown> = {}) =>
    async () => ({
      id: "42",
      kind: "user",
      isContact: false,
      ...over,
    });
  // Полный список контактов и кешированный getChatInfo больше не нужны: вызов - ошибка теста
  const forbidden = {
    getContacts: async () => {
      throw new Error("add-contact must not download the whole contact list");
    },
    getChatInfo: async () => {
      throw new Error("add-contact must not use the cached getChatInfo");
    },
  };

  it("is on with the contact edits, takes no phone and is not a guarded destructive tool", async () => {
    const t = tool("telegram-add-contact");
    assert.equal(t.requiresEnv, "MCP_TELEGRAM_ENABLE_CONTACT_EDITS");
    assert.deepEqual(Object.keys(t.inputSchema ?? {}).sort(), ["firstName", "lastName", "userId"]);
    assert.equal(t.annotations.destructiveHint, false);
    const { isGuardedDestructive } = await import("../tools/helpers.js");
    assert.equal(isGuardedDestructive(t.annotations), false);
  });

  it("adds a non-contact with one status check and no phone number", async () => {
    let args: unknown[] = [];
    let checks = 0;
    const telegram = {
      ...forbidden,
      getContactStatus: async (...a: unknown[]) => {
        checks++;
        assert.deepEqual(a, ["@bob"]);
        return statusOf()();
      },
      addContact: async (...a: unknown[]) => {
        args = a;
      },
    } as unknown as TelegramService;
    const r = await tool("telegram-add-contact").handler({ userId: "@bob", firstName: "Bob", lastName: "Partner" }, {
      telegram,
    } as never);
    assert.equal(checks, 1);
    // Запись по проверенному ID, а не по исходной строке
    assert.deepEqual(args, ["42", "Bob", "Partner"]);
    assert.equal(text(r), "Contact added: Bob Partner (42)");
  });

  it("two parallel adds of the same user: one adds, the other is refused instead of renaming", async () => {
    const book: string[] = [];
    const calls: unknown[][] = [];
    const telegram = {
      ...forbidden,
      // Состояние на момент запроса, ответ с задержкой: без очереди оба вызова увидят «не контакт»
      getContactStatus: async () => {
        const isContact = book.includes("42");
        await new Promise((r) => setTimeout(r, 5));
        return { id: "42", kind: "user", isContact };
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
          ...forbidden,
          getContactStatus: async () => ({ id: "42", kind: "user", isContact: book.includes("42") }),
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
        ...forbidden,
        getContactStatus: () => (hang ? new Promise(() => {}) : statusOf()()),
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
      // Бюджет вызова 15 мс (плюс секунда запаса): первая проверка висит до него, второй времени не остаётся
      ADD_CONTACT_DEADLINES.callBudgetMs = 1_015;
      let lookups = 0;
      const telegram = {
        ...forbidden,
        getContactStatus: () => {
          lookups++;
          return new Promise(() => {});
        },
        addContact: async () => {},
      } as unknown as TelegramService;
      const first = call(telegram, "Bob");
      const second = call(telegram, "Robert");
      await assert.rejects(first, /deadline/);
      assert.match(text(await second), /Ran out of time before adding the contact; nothing was changed/);
      assert.equal(lookups, 1);
    });

    it("no write starts once the call budget is spent, even if the check returned", async () => {
      const { ADD_CONTACT_DEADLINES } = await import("../tools/profile.js");
      ADD_CONTACT_DEADLINES.callBudgetMs = 60_000;
      const realNow = Date.now;
      let writes = 0;
      const telegram = {
        ...forbidden,
        // Проверка вернулась, но часы уже за концом бюджета вызова
        getContactStatus: async () => {
          Date.now = () => realNow() + 120_000;
          return { id: "42", kind: "user", isContact: false };
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

  it("refuses a phone number before any Telegram request", async () => {
    let checks = 0;
    const telegram = {
      ...forbidden,
      getContactStatus: async () => {
        checks++;
        return statusOf()();
      },
      addContact: async () => {},
    } as unknown as TelegramService;
    const r = (await tool("telegram-add-contact").handler({ userId: " +79990001122", firstName: "X" }, {
      telegram,
    } as never)) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    assert.equal(r.isError, true);
    assert.match(text(r), /Phone numbers are not supported/);
    assert.equal(checks, 0);
  });

  for (const [label, over, expected] of [
    ["an existing contact", { isContact: true }, /already in your contacts; use telegram-rename-contact/],
    ["a bot", { kind: "bot" }, /is a bot/],
    ["a group or channel", { kind: "other" }, /is not a user/],
  ] as const) {
    it(`refuses ${label} and never calls addContact`, async () => {
      let called = false;
      const telegram = {
        ...forbidden,
        getContactStatus: statusOf(over),
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
