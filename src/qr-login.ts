import { logger, logUser } from "./logger.js";
import type { OAuthProvider } from "./oauth.js";
import type { SessionManager } from "./session-manager.js";

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
        if (signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {}
      }, 5000);

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

      // Heartbeat — see handleQrLogin above for rationale. Without this, Telegram's QR
      // confirmation often arrives 15+ seconds after `qr.start`, and the SSE stream is
      // terminated mid-flight with ERR_HTTP2_PROTOCOL_ERROR before the `redirect` event
      // can flush — leaving the browser stuck on the spinner.
      const heartbeat = setInterval(() => {
        if (signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {}
      }, 5000);

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

        // No hint or hint failed — proceed with QR login
        logger.info("Starting QR login (no valid session hint)", {
          component: "oauth-qr",
          event: "qr.start",
        });
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
        clearInterval(heartbeat);
      }

      controller.close();
    },
  });
}
