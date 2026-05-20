import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CLOUD_ONLY, EXPLICIT_EXCLUDED } from "../parity-config.js";

describe("parity-config", () => {
  it("has unique exclusion names", () => {
    const names = EXPLICIT_EXCLUDED.map((e) => e.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, "duplicate name(s) in EXPLICIT_EXCLUDED");
  });

  it("every exclusion has a non-empty reason", () => {
    for (const entry of EXPLICIT_EXCLUDED) {
      assert.ok(entry.reason.trim().length >= 20, `reason too short for ${entry.name}: must explain WHY`);
    }
  });

  it("every exclusion name follows the telegram-* convention", () => {
    for (const entry of EXPLICIT_EXCLUDED) {
      assert.match(entry.name, /^telegram-[a-z-]+$/, `unexpected exclusion name format: ${entry.name}`);
    }
  });
});

describe("parity-config CLOUD_ONLY", () => {
  it("has unique names with non-empty reasons", () => {
    const names = CLOUD_ONLY.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, "duplicate name(s) in CLOUD_ONLY");
    for (const entry of CLOUD_ONLY) {
      assert.ok(entry.reason.trim().length >= 20, `reason too short for ${entry.name}`);
      assert.match(entry.name, /^telegram-[a-z-]+$/, `unexpected name format: ${entry.name}`);
    }
  });

  it("does not overlap with EXPLICIT_EXCLUDED — a tool can't be both cloud-only AND excluded", () => {
    const excluded = new Set(EXPLICIT_EXCLUDED.map((e) => e.name));
    for (const entry of CLOUD_ONLY) {
      assert.ok(!excluded.has(entry.name), `${entry.name} is in both CLOUD_ONLY and EXPLICIT_EXCLUDED — pick one`);
    }
  });
});

describe("parity-baseline.json", () => {
  const baselinePath = new URL("../../scripts/parity-baseline.json", import.meta.url);
  const raw = readFileSync(baselinePath, "utf8");
  const parsed: unknown = JSON.parse(raw);

  it("is a JSON object with a `pending` array", () => {
    assert.ok(parsed && typeof parsed === "object", "baseline is not an object");
    const obj = parsed as Record<string, unknown>;
    assert.ok(Array.isArray(obj.pending), "baseline.pending must be an array");
  });

  it("has only the documented top-level keys (pending + underscore metadata)", () => {
    const obj = parsed as Record<string, unknown>;
    const allowed = new Set(["pending", "_comment", "_generated"]);
    const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
    assert.deepEqual(unknown, [], `unknown top-level key(s) — extend the allowlist or rename: ${unknown.join(", ")}`);
  });

  it("pending entries are unique", () => {
    const obj = parsed as { pending: string[] };
    const unique = new Set(obj.pending);
    assert.equal(unique.size, obj.pending.length, "duplicate name(s) in baseline.pending");
  });

  it("pending entries follow the telegram-* convention", () => {
    const obj = parsed as { pending: string[] };
    for (const name of obj.pending) {
      assert.match(name, /^telegram-[a-z-]+$/, `unexpected baseline name format: ${name}`);
    }
  });

  it("pending and EXPLICIT_EXCLUDED do not overlap", () => {
    const obj = parsed as { pending: string[] };
    const excluded = new Set(EXPLICIT_EXCLUDED.map((e) => e.name));
    for (const name of obj.pending) {
      assert.ok(!excluded.has(name), `${name} is both in baseline.pending and EXPLICIT_EXCLUDED — pick one`);
    }
  });
});
