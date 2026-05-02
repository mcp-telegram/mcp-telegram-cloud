/**
 * Per-userId async mutex contract for SessionManager.
 *
 * The mutex closes two concurrency hazards:
 *   1. Cold-start race: 3 MCP clients (Claude.ai + ChatGPT + Cursor) issuing the first tool
 *      call at the same instant after a container restart would each see an empty pool and
 *      each spin up a fresh TelegramService against the same session_string →
 *      `AUTH_KEY_DUPLICATED`. With the mutex, only the first call constructs a service; the
 *      next two await it and reuse the result.
 *   2. Destroy/adopt vs pending create: if `destroyUserSession` ran while a `getOrCreateSession`
 *      connect was still in flight, the destroy could finish first and the late connect
 *      would re-populate the pool against a session_string that was just supposed to be
 *      wiped from SQLite — a live, unreferenced TelegramService. Serialising both through
 *      the same per-userId queue means destroy waits for create to finish.
 *
 * These tests use a stub TelegramService injected via the SessionManager ctor's
 * `telegramFactory` so we can observe ordering without touching GramJS or the network.
 */
// SessionManager indirectly imports `config.ts`, which validates env vars at module load.
// ESM hoists static imports above all top-level statements, so we cannot seed env before
// the import. Set them here and use a dynamic import below to control evaluation order.
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain pending microtasks and one macrotask cycle. After issuing a `withLock`-wrapped op,
 * the queue handler runs in a microtask — so before the test can observe the impl's stub
 * construction or `connect()` call, we need to let that microtask flush. `setImmediate`
 * pumps the loop one full turn, which is more reliable than counting `await Promise.resolve()`s.
 */
const flushAsync = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Minimal stub. Records every call so tests can assert ordering. `connect` is gated by
 * a per-instance deferred that the test resolves manually, letting us hold the operation
 * "in flight" while we issue concurrent calls behind it.
 *
 * Direct construction does NOT register into the factory's `created` array — only
 * factory-produced instances do. This keeps the index space clean: `created[0]` is
 * always the first stub that SessionManager produced, regardless of how many test-only
 * stubs (e.g. an externally-built `newTg` for adoptSession) were constructed alongside.
 */
class StubTelegramService {
  readonly connectDeferred = defer<boolean>();
  readonly logOutDeferred = defer<boolean>();

  private connected = false;
  private sessionString: string | undefined;

  readonly calls: string[] = [];

  async connect(): Promise<boolean> {
    this.calls.push("connect");
    const ok = await this.connectDeferred.promise;
    this.connected = ok;
    return ok;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ensureConnected(): Promise<boolean> {
    this.calls.push("ensureConnected");
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.calls.push("disconnect");
    this.connected = false;
  }

  async logOut(): Promise<boolean> {
    this.calls.push("logOut");
    return this.logOutDeferred.promise;
  }

  setSessionString(s: string): void {
    this.sessionString = s;
  }

  getSessionString(): string | undefined {
    return this.sessionString;
  }
}

interface TestRig {
  sm: SessionManagerType;
  /** Stubs that SessionManager constructed via the injected factory (in order). */
  created: StubTelegramService[];
}

function makeManager(): TestRig {
  const created: StubTelegramService[] = [];
  const sm = new SessionManager(":memory:", () => {
    const stub = new StubTelegramService();
    created.push(stub);
    return stub as unknown as TelegramService;
  });
  return { sm, created };
}

describe("SessionManager mutex — cold-start single-flight", () => {
  it("3 concurrent getOrCreateSession for the same userId construct exactly 1 TelegramService", async () => {
    const { sm, created } = makeManager();

    const p1 = sm.getOrCreateSession("user-A");
    const p2 = sm.getOrCreateSession("user-A");
    const p3 = sm.getOrCreateSession("user-A");

    // Let the first queued op drain its microtask so the stub is constructed and connect() called
    await flushAsync();

    // First constructed instance resolves connect → pool populated
    created[0].connectDeferred.resolve(true);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // Only one stub was created — the other two awaited the queue and reused the pooled instance
    assert.equal(created.length, 1, "should construct exactly one TelegramService");
    assert.equal(r1, r2);
    assert.equal(r2, r3);
    assert.equal(sm.getActiveCount(), 1);
  });

  it("different userIds run in parallel (not serialised against each other)", async () => {
    const { sm, created } = makeManager();

    const pA = sm.getOrCreateSession("user-A");
    const pB = sm.getOrCreateSession("user-B");
    await flushAsync();

    // Both should be in flight before we resolve either — proves they did NOT serialise
    // through one global lock. (If they had, instances.length would be 1 here.)
    assert.equal(created.length, 2, "both stubs constructed before either connect resolved");

    created[0].connectDeferred.resolve(true);
    created[1].connectDeferred.resolve(true);

    await Promise.all([pA, pB]);
    assert.equal(sm.getActiveCount(), 2);
  });
});

describe("SessionManager mutex — destroy/adopt vs pending create", () => {
  it("destroyUserSession waits for an in-flight getOrCreateSession to finish", async () => {
    const { sm, created } = makeManager();

    const createP = sm.getOrCreateSession("user-A");
    // Create is now in flight, blocked on connectDeferred. Issue destroy.
    const destroyP = sm.destroyUserSession("user-A");
    await flushAsync();

    // Snapshot stub call order so we can prove destroy did not start its work yet.
    // Only one stub exists (the create's), and its connect is in flight; logOut hasn't
    // been called because destroy is parked behind the mutex.
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].calls, ["connect"]);

    // Let create finish.
    created[0].connectDeferred.resolve(true);
    await createP;

    // Destroy is now unblocked; let its logOut resolve.
    created[0].logOutDeferred.resolve(true);
    const result = await destroyP;

    assert.equal(result.loggedOut, true);
    // Pool is empty: destroy ran AFTER create finished, removed the entry it had just put in.
    assert.equal(sm.getActiveCount(), 0);
    // No orphan: only one stub was ever constructed.
    assert.equal(created.length, 1);
  });

  it("adoptSession waits for an in-flight getOrCreateSession to finish", async () => {
    const { sm, created } = makeManager();

    const createP = sm.getOrCreateSession("user-A");
    // Create is in flight. Construct an external "QR-login" stub and adopt it.
    const newTg = new StubTelegramService();
    const adoptP = sm.adoptSession("user-A", newTg as unknown as TelegramService);
    await flushAsync();

    // Adopt parked behind create. Old stub has reached connect() but not logOut().
    assert.deepEqual(created[0].calls, ["connect"]);

    created[0].connectDeferred.resolve(true);
    await createP;
    // adoptSession now runs: it INSTALLS the new entry FIRST (so concurrent getSession
    // reads see the new instance immediately) and tears down the old auth key
    // fire-and-forget after the swap. So `await adoptP` does NOT depend on logOut.
    await adoptP;

    // Pool now holds the adopted instance, not the original — verifies post-swap state.
    assert.equal(sm.getActiveCount(), 1);
    assert.equal(sm.getSession("user-A"), newTg as unknown as TelegramService);
    // Resolve the in-flight logOut so the fire-and-forget cleanup completes (otherwise
    // the test process would exit with an unawaited promise warning).
    created[0].logOutDeferred.resolve(true);
    await flushAsync();
  });

  it("adoptSession installs the new session BEFORE logging out the old (no mid-logOut reads)", async () => {
    const { sm, created } = makeManager();

    // Pre-populate the pool with an "old" session by completing one getOrCreateSession.
    const p = sm.getOrCreateSession("user-A");
    await flushAsync();
    created[0].connectDeferred.resolve(true);
    await p;
    const oldStub = created[0];

    // Now adopt a freshly QR-logged-in stub.
    const newTg = new StubTelegramService();
    const adoptP = sm.adoptSession("user-A", newTg as unknown as TelegramService);

    // Critical assertion: AS SOON AS the adopt promise resolves, getSession must return
    // the new instance — even though logOut on the old one is still pending. This is what
    // protects mcp-handler.ts:140 from handing tools a being-revoked TelegramService.
    await adoptP;
    assert.equal(sm.getSession("user-A"), newTg as unknown as TelegramService);
    assert.ok(oldStub.calls.includes("logOut"), "old session logOut was queued");

    // Drain the fire-and-forget logOut so the test process exits cleanly.
    oldStub.logOutDeferred.resolve(true);
    await flushAsync();
  });
});

describe("SessionManager mutex — bookkeeping", () => {
  it("evicts the lock entry once the queue drains (no unbounded growth)", async () => {
    const { sm, created } = makeManager();

    const p = sm.getOrCreateSession("user-A");
    await flushAsync();
    created[0].connectDeferred.resolve(true);
    await p;

    // Sanity: queue is empty after the only operation finished.
    assert.equal(sm._getPendingLockCount(), 0, "lock map should be empty after queue drains");
  });

  it("retains the lock while operations are still queued", async () => {
    const { sm, created } = makeManager();

    const p1 = sm.getOrCreateSession("user-A");
    const p2 = sm.getOrCreateSession("user-A");
    await flushAsync();

    // Both are queued; lock map holds the tail.
    assert.equal(sm._getPendingLockCount(), 1);

    created[0].connectDeferred.resolve(true);
    await Promise.all([p1, p2]);

    assert.equal(sm._getPendingLockCount(), 0);
  });

  it("a thrown operation does not block the next operation in the queue for the same userId", async () => {
    const { sm, created } = makeManager();

    // The protection here comes from withLock storing a noop'd `slot` (`run.then(noop, noop)`)
    // as the queue-tail, so the next caller's `prev = locks.get(userId)` is never a rejecting
    // Promise. Rejection propagates only through `await run` to the caller of withLock — the
    // queue itself stays alive.
    const p1 = sm.getOrCreateSession("user-A");
    const p2 = sm.getOrCreateSession("user-A");
    await flushAsync();

    // Reject the first connect → first operation throws.
    created[0].connectDeferred.reject(new Error("connect blew up"));

    await assert.rejects(p1, /connect blew up/);

    // Second op MUST start despite the rejection in front of it. It's a fresh
    // getOrCreateSession against an empty pool (the failed first never inserted), so a new
    // stub gets constructed. If the rejection had cascaded, `created.length` would still be 1.
    await flushAsync();
    assert.equal(created.length, 2, "second op started after first failed");
    created[1].connectDeferred.resolve(true);
    await p2;

    assert.equal(sm.getActiveCount(), 1);
    assert.equal(sm._getPendingLockCount(), 0);
  });

  it("connect() returning false does NOT cache a broken session in the pool", async () => {
    const { sm, created } = makeManager();

    // First op: connect fails (not a thrown error, just `false` return).
    const p1 = sm.getOrCreateSession("user-A");
    await flushAsync();
    created[0].connectDeferred.resolve(false);
    await p1;

    // Pool is empty — broken sessions must not be cached, otherwise subsequent callers reuse
    // a TelegramService stuck in a half-connected state.
    assert.equal(sm.getActiveCount(), 0);
    assert.equal(sm.getSession("user-A"), undefined, "broken session not cached");
    assert.equal(sm._getPendingLockCount(), 0);

    // Second op gets a FRESH stub (no reuse of the broken one), serialised behind the first.
    const p2 = sm.getOrCreateSession("user-A");
    await flushAsync();
    assert.equal(created.length, 2, "second call constructs a fresh TelegramService, not the broken one");
    created[1].connectDeferred.resolve(true);
    await p2;
    assert.equal(sm.getActiveCount(), 1);
  });
});

describe("SessionManager mutex — disconnectUser semantics", () => {
  it("disconnectUser launches disconnect() but does not block subsequent ops on the same userId", async () => {
    const { sm, created } = makeManager();

    // Pre-populate the pool.
    const p1 = sm.getOrCreateSession("user-A");
    await flushAsync();
    created[0].connectDeferred.resolve(true);
    await p1;

    // disconnectUser is sync (fire-and-forget). It enqueues a withLock task that reads the
    // pool entry and KICKS OFF disconnect() without awaiting it.
    sm.disconnectUser("user-A");
    await flushAsync();

    // The lock-protected portion ran: disconnect() was called on the stub.
    assert.ok(created[0].calls.includes("disconnect"), "disconnect() was launched inside the lock");
    // The entry STAYS in the pool — disconnect ≠ destroy. This is what lets the next
    // getOrCreateSession reuse the same auth key.
    assert.equal(sm.getActiveCount(), 1);

    // A subsequent getOrCreateSession on the same userId completes immediately by hitting
    // the pool fast path — proving the lock did not stay held while disconnect()'s network
    // teardown is still in flight (we never resolved any disconnect promise).
    const tg = await sm.getOrCreateSession("user-A");
    assert.equal(tg, created[0] as unknown as TelegramService, "reused pooled instance, not a fresh one");
    assert.equal(created.length, 1, "no fresh TelegramService constructed under same userId");
  });

  it("disconnectUser called when the userId is not in the pool is a no-op", async () => {
    const { sm, created } = makeManager();

    // No pre-population — userId has nothing in pool.
    sm.disconnectUser("user-A");
    await flushAsync();

    assert.equal(created.length, 0, "no stub touched");
    assert.equal(sm.getActiveCount(), 0);
    // Lock entry was created and evicted cleanly.
    assert.equal(sm._getPendingLockCount(), 0);
  });
});

describe("SessionManager mutex — multi-method serialisation", () => {
  it("getOrCreateSession and tryReconnectSession on the same userId are serialised", async () => {
    const { sm, created } = makeManager();

    // Both are wrapped in withLock(userId, ...). When invoked together, the second must wait
    // for the first to settle before constructing or replacing the pooled instance — otherwise
    // each could `new TelegramService(...)` against the same session_string, reproducing
    // exactly the AUTH_KEY_DUPLICATED race we're guarding against.
    const p1 = sm.getOrCreateSession("user-A");
    const p2 = sm.tryReconnectSession("user-A");
    await flushAsync();

    // Only the first's stub is alive at this point (no SQLite session_string for tryReconnect
    // to re-hydrate, but the lock would still hold even if there were).
    assert.equal(created.length, 1, "tryReconnectSession parks behind getOrCreateSession");

    created[0].connectDeferred.resolve(true);
    await p1;

    // tryReconnectSession runs after — pool is now populated, so it hits the fast path and
    // returns the existing instance without constructing a second stub.
    const r2 = await p2;
    assert.equal(r2, created[0] as unknown as TelegramService);
    assert.equal(created.length, 1, "no second TelegramService constructed under same userId");
  });
});
