/**
 * /mcp authentication boundary (regression for the 2026-06-11 X-User-Id bypass).
 *
 * The MCP transport must derive identity ONLY from a validated OAuth Bearer
 * token. A prior version fell back to a raw `X-User-Id` request header when no
 * token was present — a pre-auth full-account-takeover: userId is a public
 * Telegram identifier, so anyone could name a victim and drive their session.
 *
 * These tests pin the boundary at the route layer: no token / bogus token /
 * X-User-Id header all yield 401 and NEVER reach handleMcpRequest.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { registerMcpRoutes } = await import("../routes/mcp.js");

// A token validator that only accepts the literal "good-token".
const oauth = {
  validateToken(token: string) {
    return token === "good-token" ? { userId: "alex", clientName: "TestClient" } : null;
  },
} as unknown as Parameters<typeof registerMcpRoutes>[1]["oauth"];

// If identity ever leaks past the auth gate, this sentinel makes the handler
// observable: handleMcpRequest is the real module, so reaching it means the
// request was authorized. We assert we get 401 BEFORE that — the handler is
// never invoked because userId stays null.
function makeApp() {
  const app = new Hono();
  registerMcpRoutes(app, {
    oauth,
    sessions: {} as never,
    usage: {} as never,
    destructive: {} as never,
    uploads: {} as never,
  });
  return app;
}

const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "telegram-status" } });
const post = (headers: Record<string, string>) =>
  makeApp().request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: BODY,
  });

describe("/mcp auth boundary", () => {
  it("401s with no Authorization header", async () => {
    const res = await post({});
    assert.equal(res.status, 401);
  });

  it("401s with an invalid Bearer token", async () => {
    const res = await post({ Authorization: "Bearer not-a-real-token" });
    assert.equal(res.status, 401);
  });

  it("REJECTS X-User-Id header as identity (no token) — regression for the takeover bypass", async () => {
    const res = await post({ "X-User-Id": "victim" });
    assert.equal(res.status, 401, "X-User-Id must NEVER authenticate a request");
  });

  it("REJECTS X-User-Id even alongside an invalid Bearer token", async () => {
    const res = await post({ Authorization: "Bearer bogus", "X-User-Id": "victim" });
    assert.equal(res.status, 401);
  });
});
