import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { scanText, BLACKLIST } = await import("../telemetry/check-telemetry-core.js");

describe("check-telemetry scanText", () => {
  it("flags raw userId in logger.warn attrs", () => {
    const findings = scanText(`logger.warn("revoke", { component: "x", userId, event: "y" });`, "f.ts");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, "userId");
  });

  it("ignores logUser(...)-wrapped values on the same line", () => {
    const findings = scanText(`logger.info("issued", { userId: logUser(uid), event: "ok" });`, "f.ts");
    assert.equal(findings.length, 0);
  });

  it("respects // telemetry-allow", () => {
    const findings = scanText(
      `logger.info("mount", { username: config.botUsername }); // telemetry-allow: public bot handle`,
      "f.ts",
    );
    assert.equal(findings.length, 0);
  });

  it("flags multiple PII keys in a single call", () => {
    const findings = scanText(`logger.error("oops", { userId, peer, messageText });`, "f.ts");
    const keys = findings.map((f) => f.key).sort();
    assert.deepEqual(keys, ["messageText", "peer", "userId"]);
  });

  it("flags PII inside recordError() too (not just logger.*)", () => {
    const findings = scanText(`recordError("boom", { authKey: "x" });`, "f.ts");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, "authKey");
  });

  it("does not flag non-logger calls (false-positive guard)", () => {
    const findings = scanText(`const r = someOtherFn("x", { userId, peer });`, "f.ts");
    assert.equal(findings.length, 0);
  });

  it("scans across multi-line attrs object (up to 20 lines)", () => {
    const text = `
logger.warn("multi", {
  component: "x",
  event: "y",
  peer: "secret-peer-id",
});
`;
    const findings = scanText(text, "f.ts");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, "peer");
  });

  it("BLACKLIST contains expected categories", () => {
    // Sanity that we did not accidentally drop a category in a refactor.
    for (const expected of ["userId", "peer", "messageText", "phone", "authKey", "accessToken", "code", "state"]) {
      assert.ok((BLACKLIST as readonly string[]).includes(expected), `BLACKLIST missing required key: ${expected}`);
    }
  });

  it("does not match similarly-named non-blacklisted keys (e.g. userIdHash, peerCount)", () => {
    const findings = scanText(`logger.info("ok", { userIdHash: "x", peerCount: 5 });`, "f.ts");
    assert.equal(findings.length, 0);
  });

  it("flags PII inside dynamic logger[level](...) bracket form", () => {
    // src/middleware/access-log.ts uses `logger[level](...)`; without bracket
    // support the grep gate is silent on that single callsite.
    const findings = scanText(`logger[level]("req", { component: "http", userId });`, "f.ts");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, "userId");
  });

  it("does not match obj.logger[x](...) — only the bare logger identifier", () => {
    // The negative lookbehind ensures we don't scan `deps.logger[level](...)`
    // or `something.logger[x](...)` — the codebase always imports `logger`
    // as a bare top-level binding.
    const findings = scanText(`deps.logger[level]("msg", { userId });`, "f.ts");
    assert.equal(findings.length, 0);
  });
});
