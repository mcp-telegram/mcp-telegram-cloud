/**
 * POST /qr/password back-channel route (routes/qr-password.ts).
 *
 * Covers:
 *   - 400 on missing/invalid body or empty password
 *   - 404 when no login is waiting on the given loginId
 *   - 204 + password delivered to the waiting login on a valid submit
 *   - 403 on a cross-origin submit (CSRF defense-in-depth)
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { createQrPasswordRoutes } = await import("../routes/qr-password.js");
const { awaitPassword, newLoginId } = await import("../qr-password-channel.js");

const app = createQrPasswordRoutes();

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /qr/password", () => {
  it("rejects a body without loginId/password (400)", async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ loginId: "abc" })).status, 400);
    assert.equal((await post({ loginId: "abc", password: 123 })).status, 400);
  });

  it("rejects an empty password (400)", async () => {
    assert.equal((await post({ loginId: "abc", password: "" })).status, 400);
  });

  it("returns 404 when no login is waiting on the id", async () => {
    const res = await post({ loginId: newLoginId(), password: "whatever" });
    assert.equal(res.status, 404);
  });

  it("delivers the password to the waiting login and returns 204", async () => {
    const id = newLoginId();
    const ac = new AbortController();
    const waiter = awaitPassword(id, ac.signal, 2000);

    const res = await post({ loginId: id, password: "cloud-secret" });
    assert.equal(res.status, 204);
    assert.equal(await waiter, "cloud-secret");
  });

  it("blocks a cross-origin submit (403)", async () => {
    const id = newLoginId();
    const ac = new AbortController();
    const waiter = awaitPassword(id, ac.signal, 2000).catch(() => "not-delivered");

    const res = await post({ loginId: id, password: "x" }, { Origin: "https://evil.example.com" });
    assert.equal(res.status, 403);

    // Same-origin still works (and settles the waiter we created above).
    const ok = await post({ loginId: id, password: "good" }, { Origin: "https://test.example.com" });
    assert.equal(ok.status, 204);
    assert.equal(await waiter, "good");
  });
});
