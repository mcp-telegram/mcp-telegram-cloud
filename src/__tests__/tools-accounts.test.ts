/**
 * v2.32.0 accounts-* MCP tools — handler behaviour with a stubbed
 * SessionManager. End-to-end add-flow is covered separately by
 * session-manager-accounts.test.ts; here we lock the user-visible strings
 * (Hermes copy-pastes them, ChatGPT and Claude.ai parse them).
 */
process.env.ISSUER ??= "https://tools-accounts-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { TOOLS } = await import("../tools.js");
const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};
const { CLOUD_ONLY } = await import("../parity-config.js");

class StubTelegramService {
  private connected = false;
  private sessionString: string | undefined;
  async connect(): Promise<boolean> {
    this.connected = true;
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async ensureConnected(): Promise<boolean> {
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async logOut(): Promise<boolean> {
    return true;
  }
  setSessionString(s: string): void {
    this.sessionString = s;
  }
  getSessionString(): string | undefined {
    return this.sessionString;
  }
}

function makeSessions(): SessionManagerType {
  return new SessionManager(":memory:", () => new StubTelegramService() as unknown as TelegramService);
}

function makeDeps(sessions: SessionManagerType, userId: string, baseUrl = "https://test.example.com") {
  return {
    telegram: undefined as unknown as TelegramService, // skipRequireConnection=true
    userId,
    sessions,
    baseUrl,
  };
}

/** Find a registered tool by name. Tests would be unable to proceed if missing,
 *  so we narrow the type by throwing — clearer than non-null assertions. */
function getTool(name: string) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Test setup: ${name} not registered`);
  return tool;
}

const ACCOUNTS_TOOL_NAMES = [
  "telegram-accounts-list",
  "telegram-accounts-current",
  "telegram-accounts-switch",
  "telegram-accounts-add",
  "telegram-accounts-remove",
] as const;

describe("v2.32.0 accounts tools — registration", () => {
  it("all 5 accounts tools are registered with skipRequireConnection=true", () => {
    for (const name of ACCOUNTS_TOOL_NAMES) {
      const tool = getTool(name);
      assert.equal(tool.skipRequireConnection, true, `${name} must skip requireConnection`);
      assert.ok(tool.description.length >= 30, `${name} description too short`);
    }
  });

  it("list + current are READ_ONLY; switch, add, remove are non-destructive WRITE", () => {
    const ro = ["telegram-accounts-list", "telegram-accounts-current"];
    const write = ["telegram-accounts-switch", "telegram-accounts-add", "telegram-accounts-remove"];
    for (const name of ro) {
      assert.equal(getTool(name).annotations.readOnlyHint, true, `${name} must be READ_ONLY`);
    }
    for (const name of write) {
      const tool = getTool(name);
      assert.equal(tool.annotations.readOnlyHint, false, `${name} must NOT be readOnlyHint=true`);
      assert.equal(
        tool.annotations.destructiveHint,
        false,
        `${name} must NOT be destructive — these are local-state mutations, not Telegram-side`,
      );
    }
  });

  it("all 5 are listed in CLOUD_ONLY (so the parity gate accepts them)", () => {
    const cloudOnly = new Set(CLOUD_ONLY.map((e) => e.name));
    for (const name of ACCOUNTS_TOOL_NAMES) {
      assert.ok(cloudOnly.has(name), `${name} missing from CLOUD_ONLY`);
    }
  });
});

describe("accounts-list handler", () => {
  it("returns 'No accounts attached yet' when owner has nothing", async () => {
    const sm = makeSessions();
    const tool = getTool("telegram-accounts-list");
    const r = await tool.handler({}, makeDeps(sm, "alex"));
    assert.match((r.content[0] as { text: string }).text, /No accounts attached yet/);
  });

  it("shows primary with ⭐ active marker", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "session-primary");
    const tool = getTool("telegram-accounts-list");
    const r = await tool.handler({}, makeDeps(sm, "alex"));
    const text = (r.content[0] as { text: string }).text;
    assert.match(text, /⭐ \[primary\] @alex/);
  });

  it("shows secondary alongside primary with switch hint", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "session-primary");
    sm.addAccount("alex", "test1", "ss1", "testing");
    const tool = getTool("telegram-accounts-list");
    const r = await tool.handler({}, makeDeps(sm, "alex"));
    const text = (r.content[0] as { text: string }).text;
    assert.match(text, /2 account/);
    assert.match(text, /⭐ \[primary\] @alex/);
    assert.match(text, /@test1 — testing/);
    assert.match(text, /telegram-accounts-switch/);
  });
});

describe("accounts-current handler", () => {
  it("returns 'Active: …' for primary when no switch has happened", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    const tool = getTool("telegram-accounts-current");
    const r = await tool.handler({}, makeDeps(sm, "alex"));
    assert.match((r.content[0] as { text: string }).text, /Active: \[primary\] @alex/);
  });

  it("returns the switched-to secondary after a switch", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    const id = sm.addAccount("alex", "test1", "ss1", "testing");
    sm.setActiveAccount("alex", id);
    const tool = getTool("telegram-accounts-current");
    const r = await tool.handler({}, makeDeps(sm, "alex"));
    const text = (r.content[0] as { text: string }).text;
    assert.match(text, /Active: \[\d+\] @test1 — testing/);
  });
});

describe("accounts-switch handler", () => {
  it("switches by label and confirms with the new @username", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    sm.addAccount("alex", "test1", "ss1", "testing");
    const tool = getTool("telegram-accounts-switch");
    const r = await tool.handler({ identifier: "testing" }, makeDeps(sm, "alex"));
    assert.match((r.content[0] as { text: string }).text, /Switched to @test1/);
  });

  it("returns an error for unknown identifier", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    const tool = getTool("telegram-accounts-switch");
    const r = await tool.handler({ identifier: "nope" }, makeDeps(sm, "alex"));
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /No account matches/);
  });
});

describe("accounts-add handler", () => {
  it("returns a single-use URL on /accounts/add/<token> with 10-minute TTL note", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    const tool = getTool("telegram-accounts-add");
    const r = await tool.handler({ label: "testing" }, makeDeps(sm, "alex", "https://app.example.com"));
    const text = (r.content[0] as { text: string }).text;
    assert.match(text, /https:\/\/app\.example\.com\/accounts\/add\/[a-f0-9]+/);
    assert.match(text, /10 minutes/);
    assert.match(text, /Label: "testing"/);
  });

  it("works without a label and omits the label hint", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    const tool = getTool("telegram-accounts-add");
    const r = await tool.handler({}, makeDeps(sm, "alex"));
    const text = (r.content[0] as { text: string }).text;
    assert.match(text, /\/accounts\/add\//);
    assert.doesNotMatch(text, /Label:/);
  });
});

describe("accounts-remove handler", () => {
  it("removes a known secondary", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    sm.addAccount("alex", "test1", "ss1", "testing");
    const tool = getTool("telegram-accounts-remove");
    const r = await tool.handler({ identifier: "testing" }, makeDeps(sm, "alex"));
    assert.match((r.content[0] as { text: string }).text, /Removed @test1/);
    assert.equal(sm.listAccounts("alex").length, 1); // primary remains
  });

  it("refuses to remove the primary", async () => {
    const sm = makeSessions();
    sm.saveSessionString("alex", "ss");
    const tool = getTool("telegram-accounts-remove");
    const r = await tool.handler({ identifier: "primary" }, makeDeps(sm, "alex"));
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /Cannot remove the primary/);
  });
});
