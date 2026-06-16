/**
 * 2FA cloud-password back-channel (qr-password-channel.ts).
 *
 * Covers:
 *   - newLoginId produces unique 128-bit hex ids
 *   - awaitPassword resolves with the submitted password and clears the waiter
 *   - submitPassword returns false for an unknown id (route → 404)
 *   - awaitPassword rejects on abort and on timeout, clearing the waiter
 *   - a retry (second awaitPassword for the same id) replaces the settled waiter
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { _pendingCount, awaitPassword, newLoginId, submitPassword } from "../qr-password-channel.js";

describe("qr-password-channel", () => {
  it("newLoginId returns unique 32-char hex tokens", () => {
    const a = newLoginId();
    const b = newLoginId();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.match(b, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b);
  });

  it("awaitPassword resolves with the submitted password and clears the waiter", async () => {
    const id = newLoginId();
    const ac = new AbortController();
    const before = _pendingCount();
    const p = awaitPassword(id, ac.signal, 1000);
    assert.equal(_pendingCount(), before + 1);
    assert.equal(submitPassword(id, "hunter2"), true);
    assert.equal(await p, "hunter2");
    assert.equal(_pendingCount(), before);
  });

  it("submitPassword returns false when no login is waiting", () => {
    assert.equal(submitPassword("does-not-exist", "x"), false);
  });

  it("awaitPassword rejects on abort and clears the waiter", async () => {
    const id = newLoginId();
    const ac = new AbortController();
    const before = _pendingCount();
    const p = awaitPassword(id, ac.signal, 1000);
    ac.abort();
    await assert.rejects(p, /aborted/);
    assert.equal(_pendingCount(), before);
    // A late submission finds nothing.
    assert.equal(submitPassword(id, "x"), false);
  });

  it("awaitPassword rejects after the timeout", async () => {
    const id = newLoginId();
    const ac = new AbortController();
    await assert.rejects(awaitPassword(id, ac.signal, 15), /timed out/);
    assert.equal(submitPassword(id, "x"), false);
  });

  it("a retry replaces the previous (already settled) waiter for the same id", async () => {
    const id = newLoginId();
    const ac = new AbortController();
    const first = awaitPassword(id, ac.signal, 1000);
    submitPassword(id, "wrong");
    assert.equal(await first, "wrong");
    // GramJS loops and asks again under the same id.
    const second = awaitPassword(id, ac.signal, 1000);
    assert.equal(submitPassword(id, "right"), true);
    assert.equal(await second, "right");
  });
});
