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

const { createMyRoutes } = await import("../routes/my.js");

// Browser sessions are opaque tokens resolved server-side (see cookie-handler.ts).
const SID_COOKIE_USER = "a".repeat(64);
const SID_STRANGER = "b".repeat(64);
const browserSessions: Record<string, string> = { [SID_COOKIE_USER]: "cookie_user", [SID_STRANGER]: "stranger" };
const getBrowserSessionUser = (t: string | undefined) => (t ? (browserSessions[t] ?? null) : null);

const ISSUER = "https://test.example.com";

/** Every `uploads.put` the route performed, in order. */
let stored: Array<{ userId: string; bytes: number; mime: string; name: string | null }> = [];

function makeApp() {
  stored = [];
  const uploads = {
    put(userId: string, bytes: Buffer, mime: string, name: string | null) {
      stored.push({ userId, bytes: bytes.byteLength, mime, name });
      return Promise.resolve({
        ok: true as const,
        id: `upl_${stored.length}`,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      });
    },
    preflight: () => null,
    listForUser: () => [],
    pendingBytesForUser: () => 0,
  };
  const sessions = { getSavedUserIds: () => ["cookie_user"] };
  const oauth = {
    // Only this one token is real, and it belongs to `bearer_user`.
    validateToken: (token: string) => (token === "good-token" ? { userId: "bearer_user", clientName: "pi" } : null),
    getBrowserSessionUser,
  };

  return createMyRoutes({
    destructive: {} as never,
    sessions: sessions as never,
    uploads: uploads as never,
    oauth: oauth as never,
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

describe("POST /my/upload — quota and size still apply to both paths", () => {
  beforeEach(() => {
    stored = [];
  });

  async function withPreflight(denied: { reason: string; message: string }, headers: Record<string, string>) {
    const uploads = {
      preflight: () => denied,
      put: () => {
        throw new Error("put must not be reached when preflight denies");
      },
      listForUser: () => [],
      pendingBytesForUser: () => 0,
    };
    const app = createMyRoutes({
      destructive: {} as never,
      sessions: { getSavedUserIds: () => ["cookie_user"] } as never,
      uploads: uploads as never,
      oauth: {
        validateToken: (t: string) => (t === "good-token" ? { userId: "bearer_user", clientName: "pi" } : null),
        getBrowserSessionUser,
      } as never,
    });
    return app.request("/upload", { method: "POST", headers, body: body() });
  }

  it("413s an oversize file on the Bearer path", async () => {
    const res = await withPreflight(
      { reason: "file_too_large", message: "too big" },
      {
        Authorization: "Bearer good-token",
      },
    );
    assert.equal(res.status, 413);
  });

  it("429s a quota-exceeded upload on the Bearer path", async () => {
    const res = await withPreflight(
      { reason: "quota_exceeded", message: "no room" },
      {
        Authorization: "Bearer good-token",
      },
    );
    assert.equal(res.status, 429);
  });

  it("413s an oversize file on the cookie path", async () => {
    const res = await withPreflight(
      { reason: "file_too_large", message: "too big" },
      {
        Cookie: `tg_sid=${SID_COOKIE_USER}`,
        Origin: ISSUER,
      },
    );
    assert.equal(res.status, 413);
  });
});
