process.env.ISSUER ??= "https://mcp-owner-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const { handleMcpRequest, _trackFullSessionForTest, _resetSessionTrackingForTest } = await import("../mcp-handler.js");

afterEach(() => _resetSessionTrackingForTest());

describe("MCP session ownership", () => {
  for (const method of ["POST", "GET", "DELETE"]) {
    it(`an unknown/expired session returns 404 for ${method} without touching Telegram`, async () => {
      let connected = 0;
      const sessions = {
        ensureActiveSession: async () => {
          connected++;
          throw new Error("Must not reconnect Telegram for an expired MCP transport");
        },
      };
      const response = await handleMcpRequest(
        sessions as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        "alice",
        "test",
        new Request("https://example.invalid/mcp", {
          method,
          headers: { "mcp-session-id": "expired-session" },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
      assert.equal(response.status, 404);
      assert.equal(connected, 0);
      assert.equal(response.headers.get("mcp-session-id"), null);
      const body = (await response.json()) as { error: { code: number } };
      assert.equal(body.error.code, -32001);
    });
  }

  it("a valid caller B cannot drive a transport/server created for A", async () => {
    let reached = 0;
    _trackFullSessionForTest(
      "alice-session",
      "script",
      "alice",
      {
        handleRequest: async () => {
          reached++;
          return new Response("owner response");
        },
        close: async () => {},
      },
      Date.now(),
    );
    const req = () =>
      new Request("https://example.invalid/mcp", {
        method: "POST",
        headers: { "mcp-session-id": "alice-session" },
        body: "{}",
      });
    const stranger = await handleMcpRequest(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      "bob",
      "test",
      req(),
    );
    assert.equal(stranger.status, 403);
    assert.equal(reached, 0);
    const owner = await handleMcpRequest(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      "alice",
      "test",
      req(),
    );
    assert.equal(owner.status, 200);
    assert.equal(await owner.text(), "owner response");
    assert.equal(reached, 1);
  });
});
