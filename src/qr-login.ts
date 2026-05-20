import { logger, logUser } from "./logger.js";
import type { OAuthProvider } from "./oauth.js";
import type { SessionManager } from "./session-manager.js";

// SSE comment-frame interval. Long enough to be cheap, short enough to stay under
// the ~15s HTTP/2 idle threshold we observed empirically against Traefik+Bun.serve.
const SSE_HEARTBEAT_INTERVAL_MS = 5000;

/** Handle QR login via SSE stream */
export async function handleQrLogin(
  sessions: SessionManager,
  userId: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Keep the HTTP/2 stream warm so intermediaries (Traefik/Bun) don't close it during idle
      // gaps between qr.start and the eventual success/redirect. SSE comments (lines starting
      // with `:`) are ignored by EventSource but count as traffic on the underlying stream.
      const heartbeat = setInterval(() => {
        if (signal.aborted) {
          clearInterval(heartbeat);
          return;
        }
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // Stream already closed/errored — nothing to do, finally will clear the interval.
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);
      signal.addEventListener("abort", () => clearInterval(heartbeat), { once: true });

      try {
        const telegram = await sessions.getOrCreateSession(userId);

        // Check if already connected
        if (await telegram.ensureConnected()) {
          const me = await telegram.getMe();
          send("connected", { name: me.firstName, username: me.username, id: me.id });
          controller.close();
          return;
        }

        send("status", { message: "Starting QR login..." });

        const result = await telegram.startQrLogin(
          // onQrDataUrl
          (dataUrl: string) => {
            if (!signal.aborted) {
              send("qr", { dataUrl });
            }
          },
          // onQrUrl
          (_url: string) => {
            if (!signal.aborted) {
              send("status", { message: "Scan the QR code in Telegram app" });
            }
          },
        );

        if (result.success) {
          // Save the new session string
          const sessionString = telegram.getSessionString();
          if (sessionString) {
            sessions.saveSessionString(userId, sessionString);
          }
          const me = await telegram.getMe();
          send("connected", { name: me.firstName, username: me.username, id: me.id });
        } else {
          send("error_msg", { message: result.message });
        }
      } catch (err) {
        send("error_msg", { message: (err as Error).message });
      } finally {
        clearInterval(heartbeat);
      }

      controller.close();
    },
  });
}

/** Handle QR login as part of OAuth authorize flow */
export async function handleOAuthQrLogin(
  sessions: SessionManager,
  oauth: OAuthProvider,
  oauthParams: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  },
  userIdHint: string | undefined,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Heartbeat is installed lazily — see `installHeartbeat` below. The fast `session.reuse`
      // path (a hinted user with a still-valid Telegram client) finishes in <200ms so the
      // heartbeat is unnecessary there; the slow QR-wait path installs it before blocking.
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const installHeartbeat = () => {
        if (heartbeat !== null || signal.aborted) return;
        heartbeat = setInterval(() => {
          if (signal.aborted) {
            if (heartbeat !== null) clearInterval(heartbeat);
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            // Stream already closed/errored — finally will clear the interval.
          }
        }, SSE_HEARTBEAT_INTERVAL_MS);
        signal.addEventListener(
          "abort",
          () => {
            if (heartbeat !== null) clearInterval(heartbeat);
          },
          { once: true },
        );
      };

      try {
        // If we have a userId hint (from cookie), try to reconnect THAT specific user
        if (userIdHint) {
          logger.info(`Attempting session reuse for hinted user: ${logUser(userIdHint)}`, {
            component: "oauth-qr",
            event: "session.reuse.attempt",
            userId: logUser(userIdHint),
          });

          const telegram = await sessions.tryReconnectSession(userIdHint);

          if (telegram) {
            const me = await telegram.getMe();

            logger.info(`Reusing existing session (user reconnected)`, {
              component: "oauth-qr",
              userId: logUser(userIdHint),
              event: "user.reuse",
            });

            const code = oauth.createAuthCode({
              clientId: oauthParams.clientId,
              userId: userIdHint,
              redirectUri: oauthParams.redirectUri,
              codeChallenge: oauthParams.codeChallenge,
              codeChallengeMethod: oauthParams.codeChallengeMethod,
            });

            const url = new URL(oauthParams.redirectUri);
            url.searchParams.set("code", code);
            if (oauthParams.state) url.searchParams.set("state", oauthParams.state);

            send("redirect", {
              url: url.toString(),
              name: me.firstName ?? "",
              username: me.username ?? "unknown",
              id: me.id,
            });
            controller.close();
            return;
          }

          logger.info(`Hinted session invalid, falling through to QR`, {
            component: "oauth-qr",
            event: "session.reuse.miss",
            userId: logUser(userIdHint),
          });
        }

        // No hint or hint failed — proceed with QR login (slow path: waits on user scan,
        // typically 5–30 seconds). Install the SSE heartbeat now so the HTTP/2 stream
        // stays warm through Telegram's confirmation round-trip.
        logger.info("Starting QR login (no valid session hint)", {
          component: "oauth-qr",
          event: "qr.start",
        });
        installHeartbeat();
        const telegram = sessions.createTempTelegram();
        await telegram.connect();

        send("status", { message: "Scan the QR code with Telegram" });

        const result = await telegram.startQrLogin(
          (dataUrl: string) => {
            if (!signal.aborted) send("qr", { dataUrl });
          },
          (_url: string) => {
            if (!signal.aborted) send("status", { message: "Scan the QR code in Telegram app" });
          },
        );

        if (result.success) {
          const me = await telegram.getMe();
          const userId = me.username ?? String(me.id);

          // Save Telegram session
          const sessionString = telegram.getSessionString();
          if (sessionString) {
            sessions.saveSessionString(userId, sessionString);
          }

          // Create OAuth auth code
          const code = oauth.createAuthCode({
            clientId: oauthParams.clientId,
            userId,
            redirectUri: oauthParams.redirectUri,
            codeChallenge: oauthParams.codeChallenge,
            codeChallengeMethod: oauthParams.codeChallengeMethod,
          });

          const url = new URL(oauthParams.redirectUri);
          url.searchParams.set("code", code);
          if (oauthParams.state) url.searchParams.set("state", oauthParams.state);

          const oauthClient = oauth.getClient(oauthParams.clientId);
          const clientName = oauthClient?.client_name ?? "";

          logger.info(`QR login success via ${clientName || "unknown"}`, {
            component: "oauth-qr",
            userId: logUser(userId),
            event: "user.login",
            client: clientName,
            clientId: oauthParams.clientId,
          });

          send("redirect", {
            url: url.toString(),
            name: me.firstName ?? "",
            username: me.username ?? "unknown",
            id: me.id,
          });

          // Adopt the temp client into the session pool — avoids creating a duplicate Telegram session
          await sessions.adoptSession(userId, telegram);
        } else {
          send("error_msg", { message: result.message ?? "QR login failed" });
        }
      } catch (err) {
        logger.error(`QR login error: ${(err as Error).message}`, { component: "oauth-qr", event: "user.login.error" });
        send("error_msg", { message: (err as Error).message });
      } finally {
        if (heartbeat !== null) clearInterval(heartbeat);
      }

      controller.close();
    },
  });
}

/**
 * v2.32.0 multi-account add-account QR flow.
 *
 * Wraps a fresh temporary `TelegramService` around the standard QR-login UX,
 * then on success calls `sessions.addAccount(ownerUserId, …)` instead of
 * saving to `user_sessions`. The new account is auto-switched to active so the
 * next MCP tool call uses it immediately. No OAuth token rotation, no
 * impact on the primary account's session.
 *
 * Sends SSE events: `qr` (data URL), `status`, `added` (success with username),
 * `error_msg`. Heartbeat lazily installed for the slow QR-wait path.
 */
export async function handleAddAccountQr(
  sessions: SessionManager,
  ownerUserId: string,
  label: string | null,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const installHeartbeat = () => {
        if (heartbeat !== null || signal.aborted) return;
        heartbeat = setInterval(() => {
          if (signal.aborted) {
            if (heartbeat !== null) clearInterval(heartbeat);
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {}
        }, SSE_HEARTBEAT_INTERVAL_MS);
        signal.addEventListener(
          "abort",
          () => {
            if (heartbeat !== null) clearInterval(heartbeat);
          },
          { once: true },
        );
      };

      try {
        installHeartbeat();
        const telegram = sessions.createTempTelegram();
        await telegram.connect();
        send("status", { message: "Scan the QR code with the Telegram account you want to add" });

        const result = await telegram.startQrLogin(
          (dataUrl: string) => {
            if (!signal.aborted) send("qr", { dataUrl });
          },
          (_url: string) => {
            if (!signal.aborted) send("status", { message: "Scan the QR code in Telegram app" });
          },
        );

        if (!result.success) {
          send("error_msg", { message: result.message ?? "QR login failed" });
          return;
        }

        const me = await telegram.getMe();
        const telegramUserId = me.username ?? String(me.id);

        // Sanity guard: refuse to "add" the OAuth-bound primary account.
        // It is already accessible without going through `telegram_accounts`,
        // and adding it as a secondary would double-bind the same identity
        // and silently steal active routing from the primary slot.
        if (telegramUserId === ownerUserId) {
          send("error_msg", {
            message: `This is already your primary account (@${telegramUserId}). Scan a DIFFERENT Telegram account.`,
          });
          // Best-effort: tear down the temp telegram so it doesn't linger.
          telegram.disconnect().catch(() => {});
          return;
        }

        const sessionString = telegram.getSessionString();
        if (!sessionString) {
          send("error_msg", { message: "Telegram returned no session string — please retry." });
          return;
        }

        const accountId = sessions.addAccount(ownerUserId, telegramUserId, sessionString, label);
        sessions.setActiveAccount(ownerUserId, accountId);

        logger.info(`Added secondary Telegram account #${accountId}`, {
          component: "accounts",
          event: "account.added",
          userId: logUser(ownerUserId),
          // `count` carries the new account_id — keeping log-fields strict
          // ALLOWED set free of one-off fields.
          count: accountId,
        });

        send("added", {
          accountId,
          username: me.username ?? "unknown",
          name: me.firstName ?? "",
          label: label ?? "",
        });

        // Hand the live TelegramService off so the user's next tool call uses
        // the in-memory client instead of paying a reconnect cost.
        telegram.disconnect().catch(() => {});
      } catch (err) {
        logger.error(`Add-account QR error: ${(err as Error).message}`, {
          component: "accounts",
          event: "account.add_error",
        });
        send("error_msg", { message: (err as Error).message });
      } finally {
        if (heartbeat !== null) clearInterval(heartbeat);
      }

      controller.close();
    },
  });
}
