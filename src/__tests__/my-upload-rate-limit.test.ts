/**
 * Rate limit on `POST /my/upload`.
 *
 * Why this exists: the pending limit counts only uploads not yet sent, and
 * `consume()` frees a slot the moment a tool uses the uploadId. So a scripted
 * caller can stream `uploadFileMaxBytes` into Telegram in a loop and never
 * trip it. That was acceptable while the route was cookie-only (a human picks
 * files by hand); the Bearer path made the route programmatically callable,
 * so request rate has to be capped too.
 *
 * Separate file because bun runs the suite in one process and the limiter's
 * buckets are process-wide — a low limit here would poison other upload tests.
 * The limit is set on `config` (not via env) because config is materialised at
 * first import, which another test file may already have triggered.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { config } = await import("../config.js");
const { createMyRoutes } = await import("../routes/my.js");

config.uploadRateLimit = 2;
config.uploadRateWindowMs = 60_000;

// Built AFTER the config override — makeUploadRateLimit() reads it here.
const app = createMyRoutes({
  destructive: {} as never,
  sessions: {
    getSavedUserIds: () => ["cookie_user"],
    getActiveAccountId: () => 0,
    getAccountAttachmentId: () => "attachment",
    listAccounts: (owner: string) => [{ accountId: 0, telegramUserId: owner, addedAt: "start" }],
    ensureAccountSession: async () => ({
      isConnected: () => true,
      uploadStream: async (_s: unknown, size: number, fileName: string) => ({ kind: "uploaded-file", size, fileName }),
    }),
  } as never,
  uploads: {
    checkCapacity: () => null,
    put: () => ({ id: "upl_x", expiresAt: new Date("2030-01-01T00:00:00.000Z") }),
    listForUser: () => [],
    pendingCountForUser: () => 0,
  } as never,
  oauth: {
    validateToken: (t: string) => (t.startsWith("tok-") ? { userId: `u_${t}`, clientName: "pi" } : null),
  } as never,
});

async function post(token: string): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1])], "a.bin", { type: "application/octet-stream" }));
  return await app.request("/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
}

describe("POST /my/upload rate limit", () => {
  it("caps a single Bearer token at the configured rate", async () => {
    assert.equal((await post("tok-a")).status, 200);
    assert.equal((await post("tok-a")).status, 200);

    const limited = await post("tok-a");
    assert.equal(limited.status, 429);
    const payload = (await limited.json()) as { error: string; retryAfter: number };
    assert.equal(payload.error, "rate_limit_exceeded");
    // Retry-After lets a well-behaved agent back off instead of hammering.
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });

  it("buckets per token — one abusive client does not lock out another", async () => {
    assert.equal((await post("tok-b")).status, 200);
    assert.equal((await post("tok-b")).status, 200);
    assert.equal((await post("tok-b")).status, 429);

    assert.equal((await post("tok-c")).status, 200);
  });
});
