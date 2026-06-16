import { randomBytes } from "node:crypto";

/**
 * Back-channel for the 2FA cloud password.
 *
 * The QR login runs inside a one-directional SSE stream (server → browser), so
 * the password the user types can't come back up that pipe. Instead the QR
 * handler emits a `password_needed` SSE event carrying an unguessable `loginId`
 * and then awaits {@link awaitPassword}; the browser POSTs the password to
 * `/qr/password`, which calls {@link submitPassword} to resolve that wait.
 *
 * State is a tiny in-memory map of pending waiters keyed by `loginId`. Nothing
 * is persisted and the password itself is never stored here — `submitPassword`
 * hands it straight to the resolver and forgets it. The `loginId` is a 128-bit
 * random token and is the only thing tying a POST to an in-flight login, so a
 * caller who doesn't hold it cannot inject a password.
 */

interface Waiter {
  resolve: (password: string) => void;
  reject: (err: Error) => void;
}

const waiters = new Map<string, Waiter>();

/** Mint an unguessable correlation id for one QR login attempt. */
export function newLoginId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Wait for the browser to POST the cloud password for `loginId`.
 *
 * Resolves with the submitted password, or rejects on `signal` abort (SSE
 * stream closed / user navigated away) or after `timeoutMs` with no input. A
 * later call for the same `loginId` (a retry after a wrong password) replaces
 * the previous waiter, which by then has already settled.
 */
export function awaitPassword(loginId: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // Only evict if we're still the registered waiter — a retry may have
      // already installed a newer one under the same id.
      if (waiters.get(loginId) === waiter) waiters.delete(loginId);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const waiter: Waiter = {
      resolve: (password) => {
        cleanup();
        resolve(password);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
    };

    timer = setTimeout(() => waiter.reject(new Error("Password entry timed out")), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.set(loginId, waiter);
  });
}

/**
 * Deliver a password submitted by the browser. Returns `false` if no login is
 * currently waiting on `loginId` (unknown/expired/already-answered) so the
 * route can answer 404 without leaking which case it was.
 */
export function submitPassword(loginId: string, password: string): boolean {
  const waiter = waiters.get(loginId);
  if (!waiter) return false;
  waiter.resolve(password);
  return true;
}

/** Test-only: number of in-flight waiters. @internal */
export function _pendingCount(): number {
  return waiters.size;
}
