import type { FC } from "hono/jsx";
import { config } from "../config.js";
import {
  card,
  clientBlock,
  errorInline,
  hidden,
  qrContainer,
  scope,
  spinner,
  status,
  step,
  subtitle,
  title,
} from "../styles.js";
import { Layout } from "./Layout.js";

interface AuthorizePageProps {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: string;
}

export const AuthorizePage: FC<AuthorizePageProps> = (props) => {
  const clientScript = `
    (() => {
      const qs = new URLSearchParams({
        client_id: ${JSON.stringify(props.clientId)},
        redirect_uri: ${JSON.stringify(props.redirectUri)},
        state: ${JSON.stringify(props.state)},
        code_challenge: ${JSON.stringify(props.codeChallenge)},
        code_challenge_method: ${JSON.stringify(props.codeChallengeMethod)}
      });

      const es = new EventSource('/oauth/authorize/qr?' + qs.toString());

      es.addEventListener('qr', (e) => {
        const data = JSON.parse(e.data);
        document.getElementById('qr-container').innerHTML =
          '<img src="' + data.dataUrl + '" alt="QR Code">';
      });

      es.addEventListener('status', (e) => {
        const data = JSON.parse(e.data);
        document.getElementById('status').textContent = data.message;
      });

      es.addEventListener('redirect', async (e) => {
        const data = JSON.parse(e.data);
        es.close();
        document.getElementById('qr-section').style.display = 'none';
        const result = document.getElementById('result');
        result.style.display = 'block';
        result.innerHTML =
          '<div style="background:#F4F4F7;border:1px solid #007AFF;border-radius:12px;padding:20px;margin:20px 0">' +
          '<h2 style="color:#007AFF;font-size:20px;margin-bottom:8px">Connected!</h2>' +
          '<p>' + (data.name || '') + ' (@' + (data.username || 'unknown') + ')</p>' +
          '<p style="margin-top:12px;font-size:13px;color:#707579">Redirecting...</p>' +
          '</div>';
        // Ask the server to set the HttpOnly tg_user hint cookie. Best-effort:
        // on failure we still redirect — losing the cookie only means the next
        // OAuth flow will show the QR again instead of the fast-redirect path.
        if (data.username && data.username !== 'unknown') {
          try {
            await fetch('/oauth/authorize/qr/cookie', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: data.username }),
              credentials: 'same-origin',
            });
          } catch {
            // ignore — redirect is more important than the hint
          }
        }
        window.location.href = data.url;
      });

      es.addEventListener('error_msg', (e) => {
        const data = JSON.parse(e.data);
        es.close();
        document.getElementById('qr-section').style.display = 'none';
        const result = document.getElementById('result');
        result.style.display = 'block';
        result.innerHTML =
          '<div style="background:#F4F4F7;border:1px solid #E53935;border-radius:12px;padding:12px"><p>' + data.message + '</p></div>';
      });

      es.onerror = () => {
        document.getElementById('status').textContent = 'Connection lost. Refresh to retry.';
      };
    })();
  `;

  return (
    <Layout title={`${config.brandName} — Authorize`}>
      <div class={card}>
        <h1 class={title}>{config.brandName}</h1>
        <p class={subtitle}>Connect your Telegram account</p>

        {props.error && <div class={errorInline}>{props.error}</div>}

        <div class={clientBlock}>
          <strong>{props.clientName || "MCP Client"}</strong> wants read-only access to your Telegram.
        </div>

        <div id="qr-section">
          <div class={qrContainer} id="qr-container">
            <div class={spinner} />
          </div>
          <div class={status} id="status">
            Connecting...
          </div>
          <div class={step}>
            <strong>Step 1:</strong> Open Telegram on your phone
          </div>
          <div class={step}>
            <strong>Step 2:</strong> Go to Settings → Devices → Link Desktop Device
          </div>
          <div class={step}>
            <strong>Step 3:</strong> Scan the QR code above
          </div>
        </div>

        <div id="result" class={hidden} />

        <p class={scope}>Scope: read-only access to chats, messages, contacts</p>
      </div>

      <script dangerouslySetInnerHTML={{ __html: clientScript }} />
    </Layout>
  );
};
