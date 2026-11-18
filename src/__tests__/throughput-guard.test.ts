process.env.ISSUER ??= "https://throughput-guard-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { guardChunks, ThroughputGuard } = await import("../media-queue.js");

describe("guardChunks", () => {
  it("does not keep chunks alive after the consumer let go of them", async () => {
    const guard = new ThroughputGuard(() => {});
    const refs: WeakRef<Uint8Array>[] = [];
    async function* source() {
      for (let i = 0; i < 100; i++) {
        const chunk = new Uint8Array(1024 * 1024);
        refs.push(new WeakRef(chunk));
        yield chunk;
      }
    }
    try {
      let total = 0;
      for await (const chunk of guardChunks(source(), guard)) total += chunk.byteLength;
      assert.equal(total, 100 * 1024 * 1024);
      // The transfer is still running (guard not stopped): nothing may pin earlier chunks.
      await new Promise((r) => setTimeout(r, 0));
      Bun.gc(true);
      const alive = refs.filter((r) => r.deref() !== undefined).length;
      assert.ok(alive <= 2, `${alive} of 100 chunks still reachable`);
    } finally {
      guard.stop();
    }
  });

  it("fails a pending read as soon as the guard fires", async () => {
    const guard = new ThroughputGuard(() => {});
    // Drive the guard by hand through its private sampler instead of waiting for the timer.
    const internals = guard as unknown as { tick: () => void; span: number };
    const fire = () => {
      for (let i = 0; i <= internals.span; i++) internals.tick();
    };
    async function* hanging() {
      yield new Uint8Array(1);
      await new Promise(() => {});
    }
    const it = guardChunks(hanging(), guard);
    await it.next();
    const pending = it.next();
    fire();
    await assert.rejects(pending, { code: "TRANSFER_TOO_SLOW" } as object);
    guard.stop();
  });
});

describe("guard settings (audit round 4)", () => {
  it("defaults: 384 KiB per 30 s of client time after a 30 s grace; buffered bodies get 3 min", async () => {
    const { mediaTimeouts } = await import("../media-queue.js");
    assert.equal(mediaTimeouts.minThroughputBytes, 384 * 1024);
    assert.equal(mediaTimeouts.throughputWindowMs, 30_000);
    assert.equal(mediaTimeouts.throughputCheckMs, 1_000);
    assert.equal(mediaTimeouts.throughputGraceMs, 30_000);
    assert.equal(mediaTimeouts.bufferedBodyMs, 180_000);
  });

  it("does not judge a client during the grace period", async () => {
    const { mediaTimeouts } = await import("../media-queue.js");
    const saved = { ...mediaTimeouts };
    Object.assign(mediaTimeouts, {
      throughputWindowMs: 20,
      throughputCheckMs: 10,
      minThroughputBytes: 1024,
      throughputGraceMs: 150,
    });
    let firedAt = 0;
    const started = Date.now();
    const guard = new ThroughputGuard(() => {
      firedAt = Date.now() - started;
    });
    try {
      guard.clientTurn(true); // the client never moves a byte
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(firedAt, 0, "not during the grace");
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(firedAt >= 140, `fired after the grace (${firedAt} ms)`);
    } finally {
      guard.stop();
      Object.assign(mediaTimeouts, saved);
    }
  });
});

describe("MediaQueue contention (audit round 4)", () => {
  it("an owner gets a second slot only when nobody else is waiting", async () => {
    const { MediaQueue } = await import("../media-queue.js");
    const q = new MediaQueue({ perUser: 2, perUserWhenContended: 1, total: 2, waitMs: 1000 });
    const a1 = await q.acquire("a");
    const a2 = await q.acquire("a"); // nobody waits: a may take both
    const order: string[] = [];
    const aAgain = q.acquire("a").then((r) => {
      order.push("a");
      return r;
    });
    a2();
    const a3 = await aAgain; // a re-takes its second slot: still nobody else waiting
    // a asks for its second slot again BEFORE b: FIFO alone would give it to a.
    const aMore = q.acquire("a").then((r) => {
      order.push("a2");
      return r;
    });
    const b = q.acquire("b").then((r) => {
      order.push("b");
      return r;
    });
    a3();
    const rb = await b;
    assert.deepEqual(order, ["a", "b"], "the freed slot goes to b, not to a's second request");
    rb();
    a1();
    (await aMore)();
    assert.deepEqual(q.stats(), { total: 0, waiting: 0 });
  });
});
