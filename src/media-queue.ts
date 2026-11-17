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
    readonly limits: { perUser: number; total: number; waitMs: number },
    private readonly busyCode: "DOWNLOAD_BUSY" | "TRANSFER_BUSY" = "DOWNLOAD_BUSY",
  ) {}

  private canRun(owner: string): boolean {
    return this.total < this.limits.total && (this.active.get(owner) ?? 0) < this.limits.perUser;
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
    return new MediaError(
      this.busyCode,
      "Too many media transfers are running for this account or on the server. Fetch media one at a time and retry.",
      3000,
    );
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

/** Inline previews and MCP chunk reads: short jobs, so callers wait for a slot. */
export const previewQueue = new MediaQueue({ perUser: 2, total: 8, waitMs: 30_000 });

/** Streams to and from Telegram (HTTP downloads, upload links, URL sources): long jobs. */
export const transferQueue = new MediaQueue({ perUser: 2, total: 8, waitMs: 30_000 }, "TRANSFER_BUSY");
