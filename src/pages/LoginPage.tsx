import type { FC } from "hono/jsx";
import { button, card, hidden, input, label, qrContainer, spinner, status, step, subtitle, title } from "../styles.js";
import { Layout } from "./Layout.js";

const clientScript = `
  var eventSource = null;

  function startLogin() {
    var userId = document.getElementById('userId').value.trim();
    if (!userId) return;

    document.getElementById('login-form').style.display = 'none';
    document.getElementById('qr-section').style.display = 'block';
    document.getElementById('startBtn').disabled = true;

    eventSource = new EventSource('/login/qr?userId=' + encodeURIComponent(userId));

    eventSource.addEventListener('qr', function(e) {
      var data = JSON.parse(e.data);
      document.getElementById('qr-container').innerHTML =
        '<img src="' + data.dataUrl + '" alt="QR Code">';
    });

    eventSource.addEventListener('status', function(e) {
      var data = JSON.parse(e.data);
      document.getElementById('status').textContent = data.message;
    });

    eventSource.addEventListener('connected', function(e) {
      var data = JSON.parse(e.data);
      eventSource.close();
      document.getElementById('qr-section').style.display = 'none';
      var result = document.getElementById('result');
      result.style.display = 'block';
      result.innerHTML =
        '<div style="background:#065f46;border-radius:12px;padding:20px;margin:20px 0">' +
        '<h2 style="color:#34d399;font-size:20px;margin-bottom:8px">Connected!</h2>' +
        '<p>' + (data.name || '') + ' (@' + (data.username || 'unknown') + ')</p>' +
        '<p style="margin-top:12px;font-size:13px;color:#94a3b8">Session saved. You can close this page.</p>' +
        '</div>';
    });

    eventSource.addEventListener('error_msg', function(e) {
      var data = JSON.parse(e.data);
      eventSource.close();
      document.getElementById('qr-section').style.display = 'none';
      var result = document.getElementById('result');
      result.style.display = 'block';
      result.innerHTML =
        '<div style="background:#7f1d1d;border-radius:12px;padding:20px;margin:20px 0"><p>' + data.message + '</p></div>';
    });

    eventSource.onerror = function() {
      document.getElementById('status').textContent = 'Connection lost. Refresh to retry.';
    };
  }

  document.getElementById('userId').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') startLogin();
  });
`;

export const LoginPage: FC = () => {
  return (
    <Layout title="MCP Telegram — Login">
      <div class={card}>
        <h1 class={title}>MCP Telegram Cloud</h1>
        <p class={subtitle}>Connect your Telegram account</p>

        <div id="login-form">
          <label class={label} for="userId">
            Your username
          </label>
          <input class={input} type="text" id="userId" placeholder="e.g. overpod" required autofocus />
          <button type="button" class={button} id="startBtn" onclick="startLogin()">
            Start QR Login
          </button>
          <div class={step}>
            <strong>Step 1:</strong> Enter your username
          </div>
          <div class={step}>
            <strong>Step 2:</strong> Scan the QR code with Telegram
          </div>
          <div class={step}>
            <strong>Step 3:</strong> Open Telegram &gt; Settings &gt; Devices &gt; Link Desktop Device
          </div>
        </div>

        <div id="qr-section" class={hidden}>
          <div class={qrContainer} id="qr-container">
            <div class={spinner} />
          </div>
          <div class={status} id="status">
            Connecting...
          </div>
        </div>

        <div id="result" class={hidden} />
      </div>

      <script dangerouslySetInnerHTML={{ __html: clientScript }} />
    </Layout>
  );
};
