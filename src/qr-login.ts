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

          console.log(`[oauth-qr] QR login success for ${userId} (${me.firstName}), redirecting...`);

          send("redirect", {
            url: url.toString(),
            name: me.firstName ?? "",
            username: me.username ?? "unknown",
            id: me.id,
          });

          // Disconnect temp client — session will be loaded by MCP handler later
          await telegram.disconnect();
        } else {
          send("error_msg", { message: result.message ?? "QR login failed" });
        }
      } catch (err) {
        console.error("[oauth-qr] Error:", err);
        send("error_msg", { message: (err as Error).message });
      }

      controller.close();
    },
  });
}

/** HTML page for /login */
export function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP Telegram — Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 16px; padding: 40px;
      max-width: 420px; width: 100%; box-shadow: 0 25px 50px rgba(0,0,0,.3);
      text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 14px; }
    .qr-container { background: white; border-radius: 12px; padding: 16px;
      display: inline-block; margin: 20px 0; min-height: 288px; min-width: 288px;
      display: flex; align-items: center; justify-content: center; }
    .qr-container img { width: 256px; height: 256px; }
    .status { color: #94a3b8; font-size: 14px; margin: 16px 0; min-height: 20px; }
    .success { background: #065f46; border-radius: 12px; padding: 20px; margin: 20px 0; }
    .success h2 { color: #34d399; font-size: 20px; margin-bottom: 8px; }
    .error { background: #7f1d1d; border-radius: 12px; padding: 20px; margin: 20px 0; }
    .step { background: #334155; border-radius: 8px; padding: 12px; margin: 8px 0;
      font-size: 13px; text-align: left; }
    .step strong { color: #60a5fa; }
    label { display: block; font-size: 14px; margin-bottom: 6px; color: #cbd5e1; text-align: left; }
    input { width: 100%; padding: 10px 14px; border: 1px solid #475569;
      border-radius: 8px; background: #0f172a; color: #e2e8f0; font-size: 16px;
      margin-bottom: 16px; outline: none; }
    input:focus { border-color: #3b82f6; }
    button { width: 100%; padding: 12px; border: none; border-radius: 8px;
      background: #3b82f6; color: white; font-size: 16px; font-weight: 600;
      cursor: pointer; transition: background .2s; }
    button:hover { background: #2563eb; }
    button:disabled { background: #475569; cursor: not-allowed; }
    .spinner { display: inline-block; width: 24px; height: 24px;
      border: 3px solid #475569; border-top-color: #3b82f6;
      border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #login-form, #qr-section, #result { display: none; }
    #login-form.active, #qr-section.active, #result.active { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <h1>MCP Telegram Cloud</h1>
    <p class="subtitle">Connect your Telegram account</p>

    <div id="login-form" class="active">
      <label for="userId">Your username</label>
      <input type="text" id="userId" placeholder="e.g. overpod" required autofocus>
      <button id="startBtn" onclick="startLogin()">Start QR Login</button>
      <div class="step"><strong>Step 1:</strong> Enter your username</div>
      <div class="step"><strong>Step 2:</strong> Scan the QR code with Telegram</div>
      <div class="step"><strong>Step 3:</strong> Open Telegram &gt; Settings &gt; Devices &gt; Link Desktop Device</div>
    </div>

    <div id="qr-section">
      <div class="qr-container" id="qr-container">
        <div class="spinner"></div>
      </div>
      <div class="status" id="status">Connecting...</div>
    </div>

    <div id="result"></div>
  </div>

  <script>
    let eventSource = null;

    function startLogin() {
      const userId = document.getElementById('userId').value.trim();
      if (!userId) return;

      document.getElementById('login-form').classList.remove('active');
      document.getElementById('qr-section').classList.add('active');
      document.getElementById('startBtn').disabled = true;

      eventSource = new EventSource('/login/qr?userId=' + encodeURIComponent(userId));

      eventSource.addEventListener('qr', (e) => {
        const data = JSON.parse(e.data);
        document.getElementById('qr-container').innerHTML =
          '<img src="' + data.dataUrl + '" alt="QR Code">';
      });

      eventSource.addEventListener('status', (e) => {
        const data = JSON.parse(e.data);
        document.getElementById('status').textContent = data.message;
      });

      eventSource.addEventListener('connected', (e) => {
        const data = JSON.parse(e.data);
        eventSource.close();
        document.getElementById('qr-section').classList.remove('active');
        document.getElementById('result').classList.add('active');
        document.getElementById('result').innerHTML =
          '<div class="success">' +
          '<h2>Connected!</h2>' +
          '<p>' + (data.name || '') + ' (@' + (data.username || 'unknown') + ')</p>' +
          '<p style="margin-top:12px;font-size:13px;color:#94a3b8">Session saved. You can close this page.</p>' +
          '</div>';
      });

      eventSource.addEventListener('error_msg', (e) => {
        const data = JSON.parse(e.data);
        eventSource.close();
        document.getElementById('qr-section').classList.remove('active');
        document.getElementById('result').classList.add('active');
        document.getElementById('result').innerHTML =
          '<div class="error"><p>' + data.message + '</p></div>';
      });

      eventSource.onerror = () => {
        document.getElementById('status').textContent = 'Connection lost. Refresh to retry.';
      };
    }

    document.getElementById('userId').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startLogin();
    });
  </script>
</body>
</html>`;
}
