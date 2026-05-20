import type { FC } from "hono/jsx";
import { config } from "../config.js";
import { button, card, hidden, qrContainer, spinner, status, step, subtitle, title } from "../styles.js";
import { Layout } from "./Layout.js";

const clientScript = (token: string) => `
  let eventSource = null;

  function startAdd() {
    document.getElementById('intro').style.display = 'none';
    document.getElementById('qr-section').style.display = 'block';

    eventSource = new EventSource('/accounts/add/${token}/qr');

    eventSource.addEventListener('qr', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('qr-container').innerHTML =
        '<img src="' + data.dataUrl + '" alt="QR Code">';
    });

    eventSource.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('status').textContent = data.message;
    });

    eventSource.addEventListener('added', (e) => {
      const data = JSON.parse(e.data);
      eventSource.close();
      document.getElementById('qr-section').style.display = 'none';
      const result = document.getElementById('result');
      result.style.display = 'block';
      const labelPart = data.label ? ' — ' + data.label : '';
      result.innerHTML =
        '<div style="background:#F4F4F7;border:1px solid #007AFF;border-radius:12px;padding:20px;margin:20px 0">' +
        '<h2 style="color:#007AFF;font-size:20px;margin-bottom:8px">Account added</h2>' +
        '<p>' + (data.name || '') + ' (@' + (data.username || 'unknown') + ')' + labelPart + '</p>' +
        '<p style="margin-top:12px;font-size:13px;color:#707579">It is now the active account in your AI client. You can close this tab.</p>' +
        '</div>';
    });

    eventSource.addEventListener('error_msg', (e) => {
      const data = JSON.parse(e.data);
      eventSource.close();
      document.getElementById('qr-section').style.display = 'none';
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.innerHTML =
        '<div style="background:#F4F4F7;border:1px solid #E53935;border-radius:12px;padding:20px;margin:20px 0">' +
        '<p>' + data.message + '</p>' +
        '<p style="margin-top:12px;font-size:13px;color:#707579">Return to your AI client and run telegram-accounts-add again to get a fresh link.</p>' +
        '</div>';
    });

    eventSource.onerror = () => {
      document.getElementById('status').textContent = 'Connection lost. Refresh to retry.';
    };
  }
`;

interface AddAccountPageProps {
  token: string;
  label: string | null;
}

export const AddAccountPage: FC<AddAccountPageProps> = ({ token, label }) => {
  return (
    <Layout title={`${config.brandName} — Add account`}>
      <div class={card}>
        <h1 class={title}>Add Telegram account</h1>
        <p class={subtitle}>
          Attach a second Telegram identity to your AI assistant.
          {label ? ` Label: "${label}".` : ""}
        </p>

        <div id="intro">
          <div class={step}>
            <strong>Step 1:</strong> Open Telegram with the account you want to add (any device)
          </div>
          <div class={step}>
            <strong>Step 2:</strong> Settings &gt; Devices &gt; Link Desktop Device
          </div>
          <div class={step}>
            <strong>Step 3:</strong> Click below and scan the QR
          </div>
          <button type="button" class={button} id="startBtn" onclick="startAdd()">
            Start QR scan
          </button>
        </div>

        <div id="qr-section" class={hidden}>
          <div class={qrContainer} id="qr-container">
            <div class={spinner} />
          </div>
          <div class={status} id="status">
            Loading QR code...
          </div>
        </div>

        <div id="result" class={hidden} />
      </div>

      <script dangerouslySetInnerHTML={{ __html: clientScript(token) }} />
    </Layout>
  );
};
