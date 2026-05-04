/**
 * Compile-time assertions on the LogFields whitelist. These tests don't
 * exercise runtime — the whole point is that violations would fail
 * `pnpm typecheck`. They run with `node:test` so the file participates
 * in the test suite (visibility) but the assertions are
 * `// @ts-expect-error` annotations that fail the build if removed.
 */

import { describe, it } from "node:test";
import type { LogFields } from "../telemetry/log-fields.js";

describe("LogFields type whitelist", () => {
  it("accepts known categorical + numeric keys", () => {
    const ok: LogFields = {
      component: "cloud",
      event: "test.case",
      userId: "u:abcdef",
      tool: "send-message",
      durationMs: 42,
      count: 1,
      enabled: 0,
    };
    void ok;
  });

  it("rejects PII keys at compile time (regression: blacklisted attribute names)", () => {
    // @ts-expect-error — `peer` is on the BLACKLIST in check-telemetry-core.ts
    const bad1: LogFields = { component: "x", peer: "raw-chat-id" };
    void bad1;
    // @ts-expect-error — `messageText` is BLACKLISTed
    const bad2: LogFields = { component: "x", messageText: "secret" };
    void bad2;
    // @ts-expect-error — raw `phone` not allowed
    const bad3: LogFields = { component: "x", phone: "+15551234" };
    void bad3;
  });

  it("rejects fresh PII-shaped keys not on the BLACKLIST yet", () => {
    // The runtime grep guard would miss these — only the type stops them.
    // @ts-expect-error — invented key, not in LogFields
    const bad1: LogFields = { component: "x", emailHash: "abc123" };
    void bad1;
    // @ts-expect-error — invented key, not in LogFields
    const bad2: LogFields = { component: "x", ipAddr: "1.2.3.4" };
    void bad2;
  });

  it("rejects wrong value type for a known key (regression on accidental widening)", () => {
    // @ts-expect-error — userId is string, not number
    const bad1: LogFields = { userId: 42 };
    void bad1;
    // @ts-expect-error — count is number, not string
    const bad2: LogFields = { count: "not-a-number" };
    void bad2;
  });
});
