import { logger } from "./logger.js";
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
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Create a temporary Telegram client for QR login (no userId yet — we'll get it from Telegram)
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

          logger.info(`QR login success: ${me.firstName} (@${me.username ?? "unknown"})`, {
            component: "oauth-qr",
            userId,
            event: "user.login",
            name: me.firstName ?? "",
            username: me.username ?? "",
            telegramId: me.id,
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
      }

      controller.close();
    },
  });
}
