/**
 * QR sign-in limits (security audit 2026-11-02).
 *
 * Every /login/qr and /oauth/authorize/qr request opens an MTProto connection under the
 * single shared API_ID and holds it for minutes. Neither route had a per-IP limit
 * (/login/qr had none at all), so a flood of anonymous requests could get the API_ID
 * throttled by Telegram for every user. Two layers: a per-IP limit on both routes and a
 * global ceiling on sign-ins running at once.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.MCP_TELEGRAM_TELEMETRY ??= "off";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QrClientFactory, QrLoginHooks } from "../qr-login-core.js";

const { runQrLogin, QR_LOGIN_BUSY, QrLoginGate } = await import("../qr-login-core.js");
const { createLoginRoutes } = await import("../routes/login.js");
const { qrLoginRateLimit } = await import("../rate-limit.js");
const { Hono } = await import("hono");
const { config } = await import("../config.js");

const hooks: QrLoginHooks = {
  onQr() {},
  onStatus() {},
  onPasswordRejected() {},
  async requestPassword() {
    return "";
  },
};

/**
 * A client that shows a QR code and then waits for a scan that never comes. Like GramJS,
 * destroying the client rejects the pending sign-in.
 */
const waitingFactory: QrClientFactory = () => {
  let destroyed = false;
  let fail: (e: Error) => void = () => {};
  return {
    connect: async () => true,
    saveSession: () => "S".repeat(120),
    destroy: async () => {
      destroyed = true;
      fail(new Error("client destroyed"));
    },
    signInUserWithQrCode: async (_creds, params) => {
      await params.qrCode({ token: Buffer.from("t"), expires: 0 });
      await new Promise<never>((_, reject) => {
        fail = reject;
        if (destroyed) reject(new Error("client destroyed"));
      });
      return {};
    },
  };
};

/** Hooks that resolve once the QR code is on screen, i.e. the sign-in holds its slot. */
function waitingHooks(): { hooks: QrLoginHooks; shown: Promise<void> } {
  let resolve: () => void = () => {};
  const shown = new Promise<void>((r) => {
    resolve = r;
  });
  return { hooks: { ...hooks, onQr: () => resolve() }, shown };
}

describe("global ceiling on concurrent QR sign-ins", () => {
  it("refuses a sign-in over the ceiling and frees the slot when one ends", async () => {
    // Own gate: test files share one process, so the process-wide counter is not ours.
    const gate = new QrLoginGate(() => 2);
    const start = (signal: AbortSignal) => {
      const w = waitingHooks();
      return { done: runQrLogin(w.hooks, signal, waitingFactory, gate), shown: w.shown };
    };
    const aborts = [new AbortController(), new AbortController()];
    const running = aborts.map((a) => start(a.signal));
    await Promise.all(running.map((r) => r.shown));

    assert.deepEqual(await start(new AbortController().signal).done, { ok: false, message: QR_LOGIN_BUSY });

    aborts[0].abort();
    await running[0].done;
    const fourth = new AbortController();
    const admitted = start(fourth.signal);
    await admitted.shown;
    fourth.abort();
    assert.notEqual((await admitted.done).message, QR_LOGIN_BUSY, "a freed slot admits the next sign-in");

    aborts[1].abort();
    await running[1].done;
  });

  it("the default ceiling comes from config", () => {
    assert.ok(config.qrLoginMaxConcurrent > 0);
  });
});

describe("per-IP limit on the QR sign-in routes", () => {
  it("/login/qr answers 429 past the limit without starting a sign-in", async () => {
    const routes = createLoginRoutes({
      sessions: {} as never,
      oauth: { createBrowserHandoff: () => "x" },
    });
    const app = new Hono();
    app.route("/login", routes);
    const hit = () => app.request("/login/qr", { headers: { "X-Real-IP": "203.0.113.77" } });

    // userId missing → 400 before any Telegram work; the limiter runs first.
    for (let i = 0; i < config.qrLoginRateLimit; i++) assert.equal((await hit()).status, 400);
    assert.equal((await hit()).status, 429);
  });

  it("the same limiter guards /oauth/authorize/qr", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../routes/oauth.tsx", import.meta.url), "utf8");
    assert.match(src, /app\.get\("\/authorize\/qr", qrLoginRateLimit,/);
    assert.equal(typeof qrLoginRateLimit, "function");
  });
});
