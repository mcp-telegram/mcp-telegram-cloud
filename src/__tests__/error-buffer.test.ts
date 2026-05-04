import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const { recordError, getRecentErrors, _resetErrorBuffer, ERROR_BUFFER_CAPACITY } = await import(
  "../telemetry/error-buffer.js"
);

afterEach(() => _resetErrorBuffer());

describe("error-buffer", () => {
  it("returns empty when nothing recorded", () => {
    assert.deepEqual(getRecentErrors(), []);
  });

  it("captures message + attrs", () => {
    recordError("boom", { component: "test", count: 42 });
    const recent = getRecentErrors();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].message, "boom");
    assert.deepEqual(recent[0].attrs, { component: "test", count: "42" });
    assert.match(recent[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops undefined attrs (so callsite shape doesn't pollute the dashboard)", () => {
    // `client: undefined` is the realistic shape — optional fields end up
    // undefined when conditionally populated; the buffer must drop them.
    recordError("partial", { component: "x", client: undefined, reason: "yes" });
    const [entry] = getRecentErrors();
    assert.deepEqual(entry.attrs, { component: "x", reason: "yes" });
  });

  it("returns most-recent-first", () => {
    recordError("first");
    recordError("second");
    recordError("third");
    const recent = getRecentErrors();
    assert.deepEqual(
      recent.map((e) => e.message),
      ["third", "second", "first"],
    );
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) recordError(`msg${i}`);
    const top3 = getRecentErrors(3);
    assert.equal(top3.length, 3);
    assert.deepEqual(
      top3.map((e) => e.message),
      ["msg9", "msg8", "msg7"],
    );
  });

  it("truncates attribute values beyond MAX_ATTR_VALUE_LEN with ellipsis", () => {
    // Defense-in-depth boundary cap: free-form keys (`error`, `context`)
    // can carry upstream-encoded strings; capping here bounds the leakage
    // shape regardless of caller-side truncation discipline.
    const long = "x".repeat(1000);
    recordError("boom", { component: "test", error: long });
    const [entry] = getRecentErrors();
    // Expect 256 truncation-chars + 1 ellipsis char
    assert.equal(entry.attrs.error.length, 257);
    assert.ok(entry.attrs.error.endsWith("…"));
    assert.equal(entry.attrs.error.slice(0, 256), "x".repeat(256));
    // Short values pass through unchanged
    assert.equal(entry.attrs.component, "test");
  });

  it("evicts oldest beyond capacity", () => {
    for (let i = 0; i < ERROR_BUFFER_CAPACITY + 5; i++) recordError(`m${i}`);
    const all = getRecentErrors();
    assert.equal(all.length, ERROR_BUFFER_CAPACITY);
    // The oldest 5 (m0..m4) must be evicted; newest (m{cap+4}) must be at front.
    assert.equal(all[0].message, `m${ERROR_BUFFER_CAPACITY + 4}`);
    assert.equal(all[all.length - 1].message, "m5");
  });
});
