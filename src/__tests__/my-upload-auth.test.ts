/**
 * `POST /my/upload` authentication boundary.
 *
 * The route serves two callers with opposite threat models:
 *
 *   - the browser dashboard, authenticated by the ambient `tg_sid` session cookie —
 *     therefore CSRF-gated on Origin/Referer;
 *   - an MCP agent, authenticated by an OAuth Bearer token — which a browser
 *     never attaches automatically, so the CSRF gate must NOT apply (and could
 *     not pass anyway: an agent has no Origin and no Referer).
 *
 * Before the Bearer path existed, every media tool (`telegram-send-file`,
 * `telegram-send-album`, …) was dead weight for an agent holding a local file:
 * the tools take only an `uploadId` or a public https URL, and `uploadId` came
 * exclusively from this cookie-gated route.
 *
 * These tests pin both branches, the precedence between them, and the CSRF
 * regression that a future "let's make it symmetric" refactor would introduce.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
// Keep the limiter out of the way here; my-upload-rate-limit.test.ts owns it.
process.env.UPLOAD_RATE_LIMIT = "1000";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const { config } = await import("../config.js");
const { createMyRoutes } = await import("../routes/my.js");

// Browser sessions are opaque tokens resolved server-side (see cookie-handler.ts).
const SID_COOKIE_USER = "a".repeat(64);
const SID_STRANGER = "b".repeat(64);
const browserSessions: Record<string, string> = { [SID_COOKIE_USER]: "cookie_user", [SID_STRANGER]: "stranger" };
const getBrowserSessionUser = (t: string | undefined) => (t ? (browserSessions[t] ?? null) : null);

const ISSUER = "https://test.example.com";

/** Every upload the route registered, in order. */
let stored: Array<{ userId: string; bytes: number; mime: string; name: string | null }> = [];
/** Every streaming upload the route sent to Telegram, with the account it used. */
let sentToTelegram: Array<{ owner: string; accountId: number; size: number; name: string }> = [];

/** Sessions double: one primary account per owner whose client records uploads. */
function fakeSessions() {
  return {
    getSavedUserIds: () => ["cookie_user"],
    getActiveAccountId: () => 0,
    getAccountAttachmentId: () => "attachment",
    listAccounts: (owner: string) => [{ accountId: 0, telegramUserId: owner, addedAt: "start" }],
    ensureAccountSession: async (owner: string, accountId: number) => ({
      isConnected: () => true,
      uploadStream: async (source: AsyncIterable<Uint8Array>, size: number, name: string) => {
        let received = 0;
        for await (const chunk of source) received += chunk.byteLength;
        assert.equal(received, size);
        sentToTelegram.push({ owner, accountId, size, name });
        return { kind: "uploaded-file", fileName: name, size, inputFile: {} };
      },
    }),
  };
}

function fakeUploads(capacityError: string | null = null) {
  return {
    checkCapacity: () => capacityError,
    put(userId: string, _binding: unknown, file: { size: number }, mime: string, name: string | null) {
      stored.push({ userId, bytes: file.size, mime, name });
      return { id: `upl_${stored.length}`, expiresAt: new Date("2030-01-01T00:00:00.000Z") };
    },
    listForUser: () => [],
    pendingBytesForUser: () => 0,
  };
}

const oauthDouble = {
  // Only this one token is real, and it belongs to `bearer_user`.
  validateToken: (token: string) => (token === "good-token" ? { userId: "bearer_user", clientName: "pi" } : null),
  getBrowserSessionUser,
};

function makeApp(uploads = fakeUploads()) {
  stored = [];
  sentToTelegram = [];
  return createMyRoutes({
    destructive: {} as never,
    sessions: fakeSessions() as never,
    uploads: uploads as never,
    oauth: oauthDouble as never,
  });
}

function body(): FormData {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" }));
  return form;
}

async function upload(headers: Record<string, string>): Promise<Response> {
  return await makeApp().request("/upload", { method: "POST", headers, body: body() });
}

describe("POST /my/upload — Bearer path (MCP agents)", () => {
  it("accepts a valid Bearer with no Origin and no Referer", async () => {
    const res = await upload({ Authorization: "Bearer good-token" });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id: string; expiresAt: string; size: number; mime: string };
    // Field name is `id` — the dashboard island and any agent script read it.
    assert.match(json.id, /^upl_/);
    assert.equal(json.size, 4);
    assert.equal(json.mime, "image/png");
  });

  it("binds the upload to the token's user, not to any cookie present", async () => {
    const res = await upload({ Authorization: "Bearer good-token", Cookie: `tg_sid=${SID_COOKIE_USER}` });
    assert.equal(res.status, 200);
    assert.deepEqual(
      stored.map((s) => s.userId),
      ["bearer_user"],
    );
  });

  it("rejects an invalid Bearer instead of falling back to a valid cookie", async () => {
    // Fallback would be an escalation: a stale token in an agent would start
    // writing as whoever is logged into the same browser profile.
    const res = await upload({
      Authorization: "Bearer not-a-real-token",
      Cookie: `tg_sid=${SID_COOKIE_USER}`,
      Origin: ISSUER,
    });
    assert.equal(res.status, 401);
    assert.deepEqual(stored, []);
  });

  it("carries WWW-Authenticate on 401 so discovery is actionable", async () => {
    const res = await upload({ Authorization: "Bearer nope" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata="https:\/\/.+"$/);
  });
});

describe("POST /my/upload — cookie path (dashboard)", () => {
  it("accepts a same-origin cookie submit", async () => {
    const res = await upload({ Cookie: `tg_sid=${SID_COOKIE_USER}`, Origin: ISSUER });
    assert.equal(res.status, 200);
    assert.deepEqual(
      stored.map((s) => s.userId),
      ["cookie_user"],
    );
  });

  it("still 403s a cookie submit with no Origin/Referer (CSRF regression)", async () => {
    const res = await upload({ Cookie: `tg_sid=${SID_COOKIE_USER}` });
    assert.equal(res.status, 403);
    assert.deepEqual(stored, []);
  });

  it("still 403s a cookie submit from a foreign origin (CSRF regression)", async () => {
    const res = await upload({ Cookie: `tg_sid=${SID_COOKIE_USER}`, Origin: "https://evil.example.org" });
    assert.equal(res.status, 403);
    assert.deepEqual(stored, []);
  });

  it("403s on a look-alike origin prefix", async () => {
    const res = await upload({ Cookie: `tg_sid=${SID_COOKIE_USER}`, Origin: "https://test.example.com.evil.io" });
    assert.equal(res.status, 403);
  });

  it("401s a cookie whose user has no saved session on this server", async () => {
    const res = await upload({ Cookie: `tg_sid=${SID_STRANGER}`, Origin: ISSUER });
    assert.equal(res.status, 401);
  });
});

describe("POST /my/upload — no credentials", () => {
  it("401s with neither cookie nor Bearer", async () => {
    const res = await upload({});
    assert.equal(res.status, 401);
    assert.deepEqual(stored, []);
  });
});

describe("POST /my/upload — bytes go straight to Telegram", () => {
  it("streams the file into Telegram with the active account and keeps only the handle", async () => {
    const res = await upload({ Authorization: "Bearer good-token" });
    assert.equal(res.status, 200);
    assert.deepEqual(sentToTelegram, [{ owner: "bearer_user", accountId: 0, size: 4, name: "shot.png" }]);
    assert.deepEqual(stored, [{ userId: "bearer_user", bytes: 4, mime: "image/png", name: "shot.png" }]);
  });
});

describe("POST /my/upload — bounded and bound to the account", () => {
  function appWithTelegram(uploadStream: (...a: unknown[]) => Promise<unknown>, attachment: () => string) {
    stored = [];
    const sessions = {
      ...fakeSessions(),
      getAccountAttachmentId: attachment,
      ensureAccountSession: async () => ({ isConnected: () => true, uploadStream }),
    };
    return createMyRoutes({
      destructive: {} as never,
      sessions: sessions as never,
      uploads: fakeUploads() as never,
      oauth: oauthDouble as never,
    });
  }

  it("a hung Telegram upload is answered at the deadline and frees the slot", async () => {
    const { mediaTimeouts, transferQueue } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, { toolTransferMs: 30, backstopMs: 60 });
    try {
      const app = appWithTelegram(
        () => new Promise(() => {}),
        () => "attachment",
      );
      const baseline = transferQueue.stats().total;
      const res = await app.request("/upload", {
        method: "POST",
        headers: { Authorization: "Bearer good-token" },
        body: body(),
      });
      assert.equal(((await res.json()) as { error: string }).error, "UPLOAD_FAILED");
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(transferQueue.stats().total, baseline);
      assert.deepEqual(stored, []);
    } finally {
      Object.assign(mediaTimeouts, saved);
    }
  });

  it("does not register an upload whose account was replaced meanwhile", async () => {
    let attachment = "attachment";
    const app = appWithTelegram(
      async () => {
        attachment = "replaced";
        return { kind: "uploaded-file", fileName: "shot.png", size: 4, inputFile: {} };
      },
      () => attachment,
    );
    const res = await app.request("/upload", {
      method: "POST",
      headers: { Authorization: "Bearer good-token" },
      body: body(),
    });
    assert.equal(((await res.json()) as { error: string }).error, "ACCOUNT_UNAVAILABLE");
    assert.deepEqual(stored, []);
  });
});

describe("POST /my/upload — limits still apply to both paths", () => {
  beforeEach(() => {
    stored = [];
  });

  it("429s when the user already holds too many pending uploads", async () => {
    const app = makeApp(fakeUploads("Too many pending uploads"));
    const callers: Record<string, string>[] = [
      { Authorization: "Bearer good-token" },
      { Cookie: `tg_sid=${SID_COOKIE_USER}`, Origin: ISSUER },
    ];
    for (const headers of callers) {
      const res = await app.request("/upload", { method: "POST", headers, body: body() });
      assert.equal(res.status, 429);
    }
    assert.deepEqual(sentToTelegram, [], "nothing reached Telegram");
  });

  it("413s a file above the per-file cap even when the body fits the multipart slack", async () => {
    const app = makeApp();
    const saved = config.uploadFileMaxBytes;
    config.uploadFileMaxBytes = 1024;
    try {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(2048)], "two-kib.bin"));
      const res = await app.request("/upload", {
        method: "POST",
        headers: { Authorization: "Bearer good-token" },
        body: form,
      });
      assert.equal(res.status, 413);
    } finally {
      config.uploadFileMaxBytes = saved;
    }
    assert.deepEqual(sentToTelegram, []);
  });

  it("413s a body above the per-file cap on both paths", async () => {
    const saved = config.uploadFileMaxBytes;
    config.uploadFileMaxBytes = 1; // read when the route is built
    let app: ReturnType<typeof makeApp>;
    try {
      app = makeApp();
    } finally {
      config.uploadFileMaxBytes = saved;
    }
    const big = () => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(2 * 1024 * 1024)], "big.bin"));
      return form;
    };
    const callers: Record<string, string>[] = [
      { Authorization: "Bearer good-token" },
      { Cookie: `tg_sid=${SID_COOKIE_USER}`, Origin: ISSUER },
    ];
    for (const headers of callers) {
      const res = await app.request("/upload", { method: "POST", headers, body: big() });
      assert.equal(res.status, 413);
    }
    assert.deepEqual(stored, []);
  });
});
