import QRCode from "qrcode";
import { TelegramClient } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";

/**
 * QR + 2FA login, implemented directly on GramJS.
 *
 * WHY THIS EXISTS — the `@overpod/mcp-telegram` `TelegramService.startQrLogin`
 * bails out the moment Telegram answers `SESSION_PASSWORD_NEEDED`: it
 * disconnects and returns `{ success: false, message: "2FA enabled …" }`,
 * leaving no way to submit the cloud password. GramJS's own
 * `signInUserWithQrCode({ qrCode, password, onError })` handles the whole flow
 * — including the SRP password check — natively, so we drive it here and hand
 * the resulting session string back to `TelegramService.setSessionString()` +
 * `connect()` (see qr-login.ts), keeping the rest of the pipeline unchanged.
 *
 * The Telegram cloud password is NEVER logged or persisted — it lives only as a
 * local variable for the duration of the SRP check inside GramJS.
 */

/** Max wrong-password retries before we give up and abort the login. Telegram
 *  also flood-limits CheckPassword server-side; this is a client-side safety
 *  cap so a leaked loginId can't drive an unbounded brute-force loop. */
const MAX_PASSWORD_ATTEMPTS = 3;

/** Overall deadline for a single QR login attempt. GramJS's QR loop has no
 *  built-in timeout (it waits for the scan forever), so we impose one and tear
 *  the client down if the user never finishes. Matches the 5-minute window the
 *  upstream manual implementation used. */
const QR_LOGIN_DEADLINE_MS = 5 * 60 * 1000;

export interface QrLoginHooks {
  /** Emit a fresh QR image (data URL) for the user to scan. */
  onQr: (dataUrl: string) => void;
  /** Optional human-readable progress line (English; surfaced verbatim to the
   *  browser like the rest of the SSE `status` events). */
  onStatus?: (message: string) => void;
  /** Telegram requires the 2FA cloud password. Resolve with the password the
   *  user supplied. Reject/throw to abort the login (e.g. on timeout/cancel).
   *  `signal` fires when the overall QR-login attempt is torn down (external
   *  abort OR the 5-minute deadline) — the implementation MUST stop waiting and
   *  reject when it fires, otherwise the deadline can't unwind a password wait. */
  requestPassword: (hint: string | undefined, signal: AbortSignal) => Promise<string>;
  /** A submitted password was rejected by Telegram; another `requestPassword`
   *  is about to be issued so the UI can show a "try again" hint. */
  onPasswordRejected?: () => void;
}

export interface QrLoginOutcome {
  ok: boolean;
  /** Telegram StringSession string — present iff `ok`. */
  sessionString?: string;
  /** Failure/abort reason — present iff `!ok`. */
  message?: string;
}

/**
 * Minimal slice of GramJS `TelegramClient` we depend on. Declared as an
 * interface so tests can inject a fake that drives the `qrCode`/`password`
 * callbacks without touching the network.
 */
export interface QrSignInParams {
  qrCode: (qr: { token: Buffer; expires: number }) => Promise<void>;
  password?: (hint?: string) => Promise<string>;
  onError: (err: Error) => Promise<boolean>;
}
export interface QrTelegramClient {
  connect(): Promise<boolean>;
  signInUserWithQrCode(creds: { apiId: number; apiHash: string }, params: QrSignInParams): Promise<unknown>;
  /** Serialize the authenticated session to a StringSession string. */
  saveSession(): string;
  destroy(): Promise<void>;
}
export type QrClientFactory = () => QrTelegramClient;

/** Mirror of the proxy resolution in `@overpod/mcp-telegram` so self-hosters
 *  who run behind TELEGRAM_PROXY_* keep working when we drive GramJS ourselves. */
function resolveProxy(): Record<string, unknown> | undefined {
  const ip = process.env.TELEGRAM_PROXY_IP;
  const port = process.env.TELEGRAM_PROXY_PORT;
  if (!ip || !port) return undefined;
  const secret = process.env.TELEGRAM_PROXY_SECRET;
  if (secret) return { ip, port: Number(port), secret, MTProxy: true };
  return {
    ip,
    port: Number(port),
    socksType: Number(process.env.TELEGRAM_PROXY_SOCKS_TYPE || "5"),
    ...(process.env.TELEGRAM_PROXY_USERNAME && { username: process.env.TELEGRAM_PROXY_USERNAME }),
    ...(process.env.TELEGRAM_PROXY_PASSWORD && { password: process.env.TELEGRAM_PROXY_PASSWORD }),
  };
}

function resolveUseWSS(proxy: unknown): boolean {
  const useWSS = process.env.TELEGRAM_USE_WSS === "true";
  // GramJS cannot combine an SSL transport with a proxy — proxy wins.
  return useWSS && !proxy;
}

function resolveBaseLogger(): Logger {
  const raw = (process.env.TELEGRAM_LOG_LEVEL || "error").toLowerCase();
  const level =
    raw === "none"
      ? LogLevel.NONE
      : raw === "warn"
        ? LogLevel.WARN
        : raw === "info"
          ? LogLevel.INFO
          : raw === "debug"
            ? LogLevel.DEBUG
            : LogLevel.ERROR;
  return new Logger(level);
}

const defaultClientFactory: QrClientFactory = () => {
  const proxy = resolveProxy();
  const client = new TelegramClient(new StringSession(""), config.telegramApiId, config.telegramApiHash, {
    connectionRetries: 5,
    useWSS: resolveUseWSS(proxy),
    // Cap gramJS's INFO-level reconnect logging so a flaky DC path can't flood
    // stdout during QR polling. Override via TELEGRAM_LOG_LEVEL when debugging.
    baseLogger: resolveBaseLogger(),
    ...(proxy && { proxy: proxy as never }),
  });
  return {
    connect: () => client.connect(),
    signInUserWithQrCode: (creds, params) => client.signInUserWithQrCode(creds, params as never),
    saveSession: () => client.session.save() as unknown as string,
    destroy: () => client.destroy(),
  };
};

/**
 * Run one QR login attempt, transparently handling the 2FA cloud-password step.
 *
 * Resolves with `{ ok: true, sessionString }` on success or `{ ok: false,
 * message }` on failure/abort — it never throws for an expected Telegram
 * outcome. `signal` cancels the attempt (the SSE request abort signal); the
 * GramJS client is destroyed on abort, timeout, and on every exit path.
 */
export async function runQrLogin(
  hooks: QrLoginHooks,
  signal: AbortSignal,
  clientFactory: QrClientFactory = defaultClientFactory,
): Promise<QrLoginOutcome> {
  if (signal.aborted) return { ok: false, message: "QR login aborted" };

  const creds = { apiId: config.telegramApiId, apiHash: config.telegramApiHash };
  const client = clientFactory();

  // Captured failure reason — set on the deadline and by onError for
  // non-retryable cases, so we surface a precise message instead of GramJS's
  // generic AUTH_USER_CANCEL / opaque disconnect error.
  let captured: string | undefined;
  let attempts = 0;
  let lastQrUrl = "";

  // Single source of "this attempt is over" — fires on external abort OR the
  // deadline. We hand its signal to the password hook so a password wait unwinds
  // too: destroying the GramJS client only rejects in-flight network invokes,
  // NOT a pending requestPassword() promise (which lives on the SSE side), so
  // without this the deadline would tear down the client yet leave the flow
  // blocked on the password until PASSWORD_ENTRY_TIMEOUT_MS — see the password
  // hook below.
  const attempt = new AbortController();
  const onAbort = () => {
    if (!attempt.signal.aborted) attempt.abort();
    client.destroy().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => {
    captured = "QR login timed out";
    onAbort();
  }, QR_LOGIN_DEADLINE_MS);

  const cleanup = () => {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
  };

  try {
    await client.connect();
    if (signal.aborted) {
      cleanup();
      await client.destroy().catch(() => {});
      return { ok: false, message: "QR login aborted" };
    }

    await client.signInUserWithQrCode(creds, {
      qrCode: async ({ token }) => {
        const url = `tg://login?token=${Buffer.from(token).toString("base64url")}`;
        // GramJS may re-emit the same token; only redraw on change.
        if (url === lastQrUrl) return;
        lastQrUrl = url;
        const dataUrl = await QRCode.toDataURL(url, { width: 256, margin: 2 });
        hooks.onQr(dataUrl);
        hooks.onStatus?.("Scan the QR code in Telegram app");
      },
      password: async (hint) => {
        attempts += 1;
        if (attempts > MAX_PASSWORD_ATTEMPTS) {
          captured = "Too many incorrect password attempts";
          throw new Error(captured);
        }
        hooks.onStatus?.("Two-factor authentication enabled — enter your cloud password");
        return hooks.requestPassword(hint, attempt.signal);
      },
      onError: async (err) => {
        const msg = (err as { errorMessage?: string }).errorMessage ?? err.message ?? "";
        // Wrong cloud password — let GramJS loop back to `password` for a retry.
        if (msg === "PASSWORD_HASH_INVALID") {
          hooks.onPasswordRejected?.();
          return false;
        }
        // Anything else is terminal; remember why and stop the flow.
        captured ??= msg;
        return true;
      },
    });

    const sessionString = client.saveSession();
    cleanup();
    await client.destroy().catch(() => {});
    if (signal.aborted) return { ok: false, message: "QR login aborted" };
    if (!sessionString) return { ok: false, message: captured ?? "QR login produced no session" };
    return { ok: true, sessionString };
  } catch (err) {
    cleanup();
    await client.destroy().catch(() => {});
    if (signal.aborted) return { ok: false, message: "QR login aborted" };
    const raw =
      captured ?? (err as { errorMessage?: string }).errorMessage ?? (err as Error).message ?? "QR login failed";
    // GramJS's generic cancel marker is meaningless to the user — map it.
    const message = raw === "AUTH_USER_CANCEL" ? (captured ?? "QR login cancelled") : raw;
    return { ok: false, message };
  }
}
