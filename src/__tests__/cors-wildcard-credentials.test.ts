/**
 * /mcp CORS invariant: wildcard origin is only safe WITHOUT credentials.
 *
 * The route intentionally serves `Access-Control-Allow-Origin: *` because MCP
 * clients are an open set (ChatGPT, Claude, Cursor, Codex, ...) whose origins
 * cannot be enumerated. That is safe for exactly one reason: identity on this
 * endpoint comes only from an OAuth Bearer token in the Authorization header,
 * never from a cookie, and CORS credentials are not enabled — so a browser
 * never attaches ambient credentials cross-origin and a hostile page has no
 * way to obtain someone else's token.
 *
 * Pair `origin: "*"` with `credentials: true` and that reasoning collapses:
 * every website would be able to drive an authenticated Telegram session with
 * the victim's cookies. These tests fail the build if the two are ever
 * combined, so the security argument in routes/mcp.ts stays enforced rather
 * than merely asserted.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { registerMcpRoutes } = await import("../routes/mcp.js");

const oauth = {
  validateToken: () => null,
} as unknown as Parameters<typeof registerMcpRoutes>[1]["oauth"];

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

const preflight = (path: string) =>
  makeApp().request(path, {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });

describe("/mcp CORS", () => {
  for (const path of ["/mcp", "/mcp/"]) {
    it(`${path}: never enables credentials`, async () => {
      const res = await preflight(path);

      // Unconditional on purpose. Guarding this with `if (origin === "*")` would
      // make the test evaporate the moment the wildcard changed — exactly when
      // the CORS config is being edited and most needs a guard. Credentials must
      // stay off on this route regardless of what the origin becomes.
      assert.equal(
        res.headers.get("access-control-allow-credentials"),
        null,
        "Access-Control-Allow-Credentials must never be enabled on /mcp: combined with a wildcard origin " +
          "it would let any website drive an authenticated session using the victim's ambient credentials",
      );
    });

    it(`${path}: still serves the documented wildcard origin`, async () => {
      const res = await preflight(path);

      // Pins the other half of the invariant the comment in routes/mcp.ts claims.
      // Narrowing the origin may well be right one day — but it must be a
      // deliberate edit that also revisits that comment, not a silent drift.
      assert.equal(
        res.headers.get("access-control-allow-origin"),
        "*",
        "MCP client origins are not enumerable; if this is being narrowed, update the rationale in routes/mcp.ts",
      );
    });
  }

  it("still rejects an unauthenticated POST regardless of Origin", async () => {
    const res = await makeApp().request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401, "CORS is not an auth boundary — the Bearer check is");
  });
});
