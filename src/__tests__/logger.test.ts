import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
// logger.ts caches OTLP_ENDPOINT and OTLP_ACTIVE at module load — set both before
// importing so flush() actually attempts the fetch we want to inspect.
process.env.MCP_TELEGRAM_TELEMETRY = "on";
process.env.SIGNOZ_ENDPOINT = "https://signoz.test";

const { logger } = await import("../logger.js");

describe("logger — OTLP auth header (mirrors metrics.ts auth tests)", () => {
  it("flush() omits Authorization header when SIGNOZ_AUTH is empty (backward-compat)", async () => {
    const { config: cfg } = await import("../config.js");
    const origAuth = cfg.signozAuth;
    (cfg as { signozAuth: string }).signozAuth = "";
    logger.info("seed", { component: "test" });
    const captured: { headers: Record<string, string> } = { headers: {} };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await logger.flush();
      assert.equal(captured.headers["Content-Type"], "application/json");
      assert.equal(captured.headers.Authorization, undefined, "no Authorization when auth empty");
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { signozAuth: string }).signozAuth = origAuth;
    }
  });

  it("flush() emits Basic Authorization header when SIGNOZ_AUTH is set", async () => {
    const { config: cfg } = await import("../config.js");
    const origAuth = cfg.signozAuth;
    (cfg as { signozAuth: string }).signozAuth = "ingest-user:s3cret-pw";
    logger.info("seed", { component: "test" });
    const captured: { headers: Record<string, string> } = { headers: {} };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured.headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("");
    };
    try {
      await logger.flush();
      const expected = `Basic ${Buffer.from("ingest-user:s3cret-pw").toString("base64")}`;
      assert.equal(captured.headers.Authorization, expected);
    } finally {
      globalThis.fetch = origFetch;
      (cfg as { signozAuth: string }).signozAuth = origAuth;
    }
  });
});
