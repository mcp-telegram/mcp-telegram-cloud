import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIENT_CLASSES, classifyClient } from "../middleware/classify-client.js";

describe("classifyClient", () => {
  it("recognizes Claude UAs", () => {
    assert.equal(classifyClient("Claude-User/1.0"), "claude");
    assert.equal(classifyClient("python-anthropic-sdk/0.45"), "claude");
    assert.equal(classifyClient("Claude.ai/web"), "claude");
  });

  it("recognizes ChatGPT/OpenAI UAs", () => {
    assert.equal(classifyClient("ChatGPT-User/2.0"), "chatgpt");
    assert.equal(classifyClient("OpenAI/Connector"), "chatgpt");
  });

  it("classifies common bot signatures", () => {
    assert.equal(classifyClient("Googlebot/2.1"), "bot");
    assert.equal(classifyClient("UptimeBot scanner"), "bot");
    assert.equal(classifyClient("crawler v2"), "bot");
  });

  it("classifies browser UAs", () => {
    assert.equal(
      classifyClient(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0",
      ),
      "browser",
    );
    assert.equal(classifyClient("Mozilla/5.0 Firefox/118.0"), "browser");
  });

  it("classifies scripted clients", () => {
    assert.equal(classifyClient("curl/8.4.0"), "script");
    assert.equal(classifyClient("node-fetch/3.0"), "script");
    assert.equal(classifyClient("Python/3.11 aiohttp/3.9"), "script");
  });

  it("returns 'empty' for missing UA", () => {
    assert.equal(classifyClient(""), "empty");
  });

  it("returns 'other' for unrecognized UAs", () => {
    assert.equal(classifyClient("MyCustomAgent/1.0"), "other");
  });

  it("CLIENT_CLASSES enumerates every output", () => {
    // Property: every value classifyClient returns must be in CLIENT_CLASSES.
    // Spot-check via explicit cases — exhaustive enum guard happens at type level.
    const observed = new Set<string>([
      classifyClient("Claude/1"),
      classifyClient("ChatGPT/1"),
      classifyClient("bot"),
      classifyClient("Mozilla/5.0"),
      classifyClient("curl/8"),
      classifyClient(""),
      classifyClient("zzz"),
    ]);
    for (const v of observed) {
      assert.ok((CLIENT_CLASSES as readonly string[]).includes(v), `value "${v}" missing from CLIENT_CLASSES`);
    }
  });

  it("CLIENT_CLASSES has bounded cardinality", () => {
    // Guards against accidental unbounded label space — gauge providers iterate
    // this list, so adding a value requires a deliberate edit.
    assert.equal(
      CLIENT_CLASSES.length,
      7,
      "Adding a class? Update gauge providers in server.tsx + dashboard widgets in SigNoz",
    );
  });

  it("respects ordering precedence: bot > browser > script", () => {
    // A UA that contains both browser AND script tokens classifies as browser
    // (real browsers carry many tokens; intentional behavior).
    assert.equal(classifyClient("Mozilla/5.0 fetch"), "browser");
    // bot keywords match before browser keywords.
    assert.equal(classifyClient("Mozilla/5.0 (compatible; Googlebot/2.1)"), "bot");
    // claude/chatgpt match before bot.
    assert.equal(classifyClient("Claude-Bot/1"), "claude");
    assert.equal(classifyClient("ChatGPT-Bot/1"), "chatgpt");
  });
});
