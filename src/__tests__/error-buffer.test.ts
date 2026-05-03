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
    recordError("boom", { component: "test", code: 42 });
    const recent = getRecentErrors();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].message, "boom");
    assert.deepEqual(recent[0].attrs, { component: "test", code: "42" });
    assert.match(recent[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops undefined attrs (so callsite shape doesn't pollute the dashboard)", () => {
    recordError("partial", { component: "x", missing: undefined, present: "yes" });
    const [entry] = getRecentErrors();
    assert.deepEqual(entry.attrs, { component: "x", present: "yes" });
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

  it("evicts oldest beyond capacity", () => {
    for (let i = 0; i < ERROR_BUFFER_CAPACITY + 5; i++) recordError(`m${i}`);
    const all = getRecentErrors();
    assert.equal(all.length, ERROR_BUFFER_CAPACITY);
    // The oldest 5 (m0..m4) must be evicted; newest (m{cap+4}) must be at front.
    assert.equal(all[0].message, `m${ERROR_BUFFER_CAPACITY + 4}`);
    assert.equal(all[all.length - 1].message, "m5");
  });
});
