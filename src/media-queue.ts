import { config } from "./config.js";
import { MediaError } from "./media-errors.js";

interface Waiter {
  owner: string;
  grant: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Fair-enough slot limiter: at most `perUser` jobs per owner and `total` overall.
 * Extra callers wait in FIFO order up to `waitMs` instead of failing at once; a
 * waiter whose owner is at its own cap does not block other owners behind it.
 */
export class MediaQueue {
  private active = new Map<string, number>();
  private total = 0;
  private waiters: Waiter[] = [];

  constructor(
    readonly limits: {
      perUser: number;
      total: number;
      waitMs: number;
      /** Per-owner cap while another owner waits: a second slot only when nobody else needs one. */
      perUserWhenContended?: number;
    },
    private readonly busyCode: "DOWNLOAD_BUSY" | "TRANSFER_BUSY" = "DOWNLOAD_BUSY",
    private readonly busyMessage = "Too many media transfers are running for this account or on the server. Fetch media one at a time and retry.",
  ) {}

  private canRun(owner: string): boolean {
    if (this.total >= this.limits.total) return false;
    const contended = this.limits.perUserWhenContended !== undefined && this.waiters.some((w) => w.owner !== owner);
    const cap = contended ? (this.limits.perUserWhenContended as number) : this.limits.perUser;
    return (this.active.get(owner) ?? 0) < cap;
  }

  private take(owner: string): () => void {
    this.total++;
    this.active.set(owner, (this.active.get(owner) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const left = (this.active.get(owner) ?? 1) - 1;
      if (left > 0) this.active.set(owner, left);
      else this.active.delete(owner);
      this.pump();
    };
  }

  private pump(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i] as Waiter;
      if (this.canRun(w.owner)) {
        this.waiters.splice(i, 1);
        if (w.timer) clearTimeout(w.timer);
        w.grant();
      } else {
        i++;
      }
    }
  }

  /** Wait for a slot (up to `waitMs`, or not at all when `wait` is false). Returns a release function. */
  acquire(owner: string, opts: { wait?: boolean } = {}): Promise<() => void> {
    if (this.canRun(owner)) return Promise.resolve(this.take(owner));
    const waitMs = opts.wait === false ? 0 : this.limits.waitMs;
    if (waitMs <= 0) return Promise.reject(this.busy());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        owner,
        grant: () => resolve(this.take(owner)),
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(this.busy());
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  async run<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(owner);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Take a slot as a {@link Lease}; every Telegram step then runs through it. */
  async lease(owner: string, opts: { wait?: boolean } = {}): Promise<Lease> {
    return new Lease(await this.acquire(owner, opts));
  }

  /** One bounded Telegram step in its own slot (previews, metadata, MCP chunk reads, URL uploads). */
  async runWithDeadline<T>(
    owner: string,
    fn: (signal: AbortSignal) => Promise<T>,
    timeout: number | CallBudget,
    code: StepCode = "DOWNLOAD_FAILED",
    onTimeout?: () => void,
  ): Promise<T> {
    const lease = await this.lease(owner);
    try {
      // A call budget is read after the slot is granted: time spent queueing counts too.
      const timeoutMs = typeof timeout === "number" ? timeout : timeout.take();
      return await lease.step(fn, timeoutMs, code, onTimeout);
    } finally {
      lease.end();
    }
  }

  private busy(): MediaError {
    return new MediaError(this.busyCode, this.busyMessage, 3000);
  }

  /** For tests and gauges. */
  stats(): { total: number; waiting: number } {
    return { total: this.total, waiting: this.waiters.length };
  }
}

/**
 * Every deadline of the media paths, in one place. Mutable only so tests can shorten
 * them. A deadline answers the caller at once; the slot itself is freed when the
 * Telegram call settles, or after `backstopMs` if it never does.
 */
export const mediaTimeouts = {
  /** One short step: metadata lookup, inline preview, one MCP chunk. */
  stepMs: 60_000,
  /** Connecting the account and finding the file before an HTTP download starts. */
  lookupMs: 60_000,
  /** Longest pause Telegram may take for one 512 KiB request of an HTTP download. */
  chunkMs: 60_000,
  /** Ceiling for one whole HTTP transfer (2000 MiB at ~1 MB/s fits). */
  totalMs: 60 * 60_000,
  /**
   * Budget of ONE upload/send tool call, shared by all its steps (album items, URL
   * fetches, the send): the registry's slow-tool timeout minus a margin, so the call is
   * answered by us and no step keeps transferring after the client got its error.
   */
  toolTransferMs: Math.max(60_000, config.toolTimeoutSlowMs - 60_000),
  /** Longest a slot stays held after its caller was answered while a Telegram call still runs. */
  backstopMs: 120_000,
  /**
   * Minimum-throughput guard of streaming transfers (see {@link ThroughputGuard}): a client
   * that moves fewer than `minThroughputBytes` in any `throughputWindowMs` of its own time
   * is cut off, so a trickling reader or uploader can't keep a slot for the whole `totalMs`.
   * 384 KiB per 30 s is ~13 KiB/s (~100 kbit/s), below EDGE/2G throughput, so only a
   * deliberately trickling client trips it. A real client may pause: the faster it was
   * before, the longer the pause it survives (at 1 MB/s, ~29 s). Time spent waiting on
   * Telegram never counts against the client.
   */
  minThroughputBytes: 384 * 1024,
  throughputWindowMs: 30_000,
  /** Sampling step of the guard; the window slides by this much. */
  throughputCheckMs: 1_000,
  /** Client time before the guard judges at all (connection setup, TCP slow start). */
  throughputGraceMs: 30_000,
  /**
   * How long a body that is buffered in memory (dashboard upload, URL without
   * Content-Length; at most `uploadFileMaxBytes`) may take to arrive. Keeps the few buffer
   * slots turning over; large files on slow links go through upload links instead.
   */
  bufferedBodyMs: 180_000,
};

type StepCode = "DOWNLOAD_FAILED" | "UPLOAD_FAILED";

/** A step deadline fired: the Telegram call may still complete on Telegram's side. */
export class StepTimeoutError extends MediaError {}

/** One deadline shared by every media step of one tool call. */
export class CallBudget {
  private readonly end: number;
  constructor(totalMs: number = mediaTimeouts.toolTransferMs) {
    this.end = Date.now() + totalMs;
  }

  /** Time left for the next step; refuses to start one when the call has used it all. */
  take(): number {
    const left = this.end - Date.now();
    if (left <= 0) {
      throw new MediaError(
        "UPLOAD_FAILED",
        "This call ran out of time before its next step, which was not started. Retry with fewer or smaller files.",
      );
    }
    return left;
  }
}

/**
 * A held queue slot. Each Telegram or remote-body await runs through {@link step}: it
 * gets a deadline that answers the caller and an abort signal. {@link end} frees the
 * slot once every step started under the lease has settled (a Telegram call can't be
 * cancelled), or after the backstop if one never does, so abort-and-retry loops can't
 * stack orphan calls beyond the limits.
 */
export class Lease {
  private readonly ctrl = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private ended = false;

  constructor(private readonly release: () => void) {}

  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  abort(reason: unknown): void {
    this.ctrl.abort(reason);
  }

  /** Run `fn` with the lease's signal; reject at `timeoutMs` or as soon as the lease aborts. */
  /**
   * Run `fn` with the lease's signal; reject at `timeoutMs` or as soon as the lease aborts.
   * `onTimeout` runs when the deadline fires, e.g. to mark the account's client wedged.
   */
  step<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    code: StepCode = "DOWNLOAD_FAILED",
    onTimeout?: () => void,
  ): Promise<T> {
    if (this.ended) return Promise.reject(new Error("Lease already ended"));
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    const work = Promise.resolve().then(() => fn(this.signal));
    this.pending.add(work);
    const forget = () => this.pending.delete(work);
    work.then(forget, forget);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const bounded = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const what = code === "UPLOAD_FAILED" ? "finish the upload" : "answer";
        const err = new StepTimeoutError(
          code,
          `Telegram did not ${what} within ${Math.round(timeoutMs / 1000)}s. Retry.`,
          3000,
        );
        try {
          onTimeout?.();
        } catch {
          // recovery is best-effort and must not hide the timeout
        }
        this.ctrl.abort(err);
        reject(err);
      }, timeoutMs);
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([work, bounded]).finally(() => {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    });
  }

  /** Free the slot after every started step settled, or after the backstop. Idempotent. */
  end(then?: () => void): void {
    if (this.ended) return;
    this.ended = true;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      clearTimeout(backstop);
      this.release();
      then?.();
    };
    backstop = setTimeout(done, mediaTimeouts.backstopMs);
    Promise.allSettled([...this.pending]).then(done);
  }
}

/** A stream moved too little for too long; see {@link ThroughputGuard}. */
export class SlowTransferError extends MediaError {}

/**
 * Cuts off a stream whose client moves fewer than `minThroughputBytes` within any
 * `throughputWindowMs` of the CLIENT's time. The caller marks whose turn it is with
 * {@link clientTurn}: while we wait for Telegram the guard's clock stands still, so a
 * slow Telegram answer never counts against the client. Samples are taken every
 * `throughputCheckMs`; the window slides by that step.
 */
export class ThroughputGuard {
  private moved = 0;
  private turn = false;
  private readonly history: number[] = [0];
  private readonly span: number;
  private readonly graceTicks: number;
  private ticks = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly fired = new AbortController();
  /** Aborted with the guard's error when it fires. */
  get signal(): AbortSignal {
    return this.fired.signal;
  }

  constructor(private readonly onStall: (err: SlowTransferError) => void) {
    const { throughputWindowMs, throughputCheckMs, throughputGraceMs } = mediaTimeouts;
    this.span = Math.max(1, Math.round(throughputWindowMs / throughputCheckMs));
    this.graceTicks = Math.round(throughputGraceMs / throughputCheckMs);
    this.timer = setInterval(() => this.tick(), throughputCheckMs);
    this.timer.unref?.();
  }

  /** Bytes the client took (download) or sent (upload). */
  count(bytes: number): void {
    this.moved += bytes;
  }

  /** True while we wait for the client; false while we wait for Telegram. */
  clientTurn(on: boolean): void {
    this.turn = on;
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private tick(): void {
    if (this.stopped || !this.turn) return;
    this.ticks++;
    this.history.push(this.moved);
    if (this.history.length > this.span + 1) this.history.shift();
    if (this.history.length < this.span + 1 || this.ticks < this.graceTicks) return;
    const inWindow = this.moved - (this.history[0] as number);
    if (inWindow >= mediaTimeouts.minThroughputBytes) return;
    this.stop();
    const seconds = Math.round(mediaTimeouts.throughputWindowMs / 1000);
    const err = new SlowTransferError(
      "TRANSFER_TOO_SLOW",
      `The transfer moved only ${inWindow} bytes in ${seconds}s and was stopped. Retry on a faster or steadier connection.`,
      3000,
    );
    this.fired.abort(err);
    this.onStall(err);
  }
}

/**
 * `p`, or the signal's reason as soon as it aborts. The abort listener lives only while
 * `p` is pending: a shared promise raced against every read would keep each settled
 * read, and so every chunk, reachable until the transfer ends.
 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Pass `source` through, counting bytes and handing the turn to the client while each
 * chunk is awaited. Fails with the guard's error as soon as it fires, even while a read
 * of the source is still pending.
 */
export async function* guardChunks(
  source: AsyncIterable<Uint8Array>,
  guard: ThroughputGuard,
): AsyncGenerator<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      guard.clientTurn(true);
      const next = await untilAborted(it.next(), guard.signal);
      guard.clientTurn(false);
      if (next.done) return;
      guard.count(next.value.byteLength);
      yield next.value;
    }
  } finally {
    guard.clientTurn(false);
    it.return?.(undefined)?.catch(() => {});
  }
}

/** Inline previews and MCP chunk reads: short jobs, so callers wait for a slot. */
export const previewQueue = new MediaQueue({ perUser: 2, total: 8, waitMs: 30_000 });

/**
 * Streams to and from Telegram (HTTP downloads, upload links, URL sources): long jobs
 * whose pace the remote side sets, guarded by {@link ThroughputGuard}.
 */
export const transferQueue = new MediaQueue({ perUser: 2, total: 16, waitMs: 30_000 }, "TRANSFER_BUSY");

/**
 * The send call of a send tool (bytes already in Telegram). Its own pool, so long streams
 * of other accounts can't make every send wait for a slot.
 */
export const sendQueue = new MediaQueue({ perUser: 2, total: 16, waitMs: 30_000 }, "TRANSFER_BUSY");

/**
 * Transfers that hold a whole file in memory before Telegram sees it (dashboard uploads,
 * URL sources without Content-Length, up to `uploadFileMaxBytes` each). Few server-wide,
 * so parallel requests can't add up to the container's memory limit.
 */
export const bufferQueue = new MediaQueue(
  { perUser: 2, perUserWhenContended: 1, total: 4, waitMs: 30_000 },
  "TRANSFER_BUSY",
);

/**
 * Concurrent streaming transfers per client IP, across accounts: half the server pool, so
 * one network can't hold every slot by opening many accounts. Generous enough for many
 * users behind one carrier NAT.
 */
export const ipQueue = new MediaQueue(
  { perUser: 8, total: Number.MAX_SAFE_INTEGER, waitMs: 0 },
  "TRANSFER_BUSY",
  "Too many media transfers are running from this network. Wait for one to finish and retry.",
);

/**
 * A {@link Lease} of the transfer pool that also holds a slot of the client IP's pool;
 * both go together when the lease ends. `ip` "unknown" (no proxy headers) is not limited.
 */
export async function leaseTransfer(owner: string, ip: string, opts: { wait?: boolean } = {}): Promise<Lease> {
  const releaseIp = ip && ip !== "unknown" ? await ipQueue.acquire(ip, { wait: false }) : () => {};
  try {
    const release = await transferQueue.acquire(owner, opts);
    return new Lease(() => {
      release();
      releaseIp();
    });
  } catch (e) {
    releaseIp();
    throw e;
  }
}

/**
 * Abort `lease` if the buffered body has not fully arrived within `bufferedBodyMs`.
 * Returns the function that cancels the deadline once the body is in.
 */
export function bufferedBodyDeadline(lease: Lease): () => void {
  const seconds = Math.round(mediaTimeouts.bufferedBodyMs / 1000);
  const timer = setTimeout(
    () =>
      lease.abort(
        new SlowTransferError(
          "TRANSFER_TOO_SLOW",
          `The file did not arrive within ${seconds}s. On a slow connection send large files through an upload link (telegram-create-upload-link), which has no such limit.`,
          3000,
        ),
      ),
    mediaTimeouts.bufferedBodyMs,
  );
  return () => clearTimeout(timer);
}
