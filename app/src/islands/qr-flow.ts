/**
 * Reusable QR-login flow island, shared by the Login, Add-Account, and OAuth
 * Authorize pages. Replaces three near-identical hand-written inline scripts.
 *
 * Behavior is data-attribute driven so the island stays i18n- and route-
 * agnostic. The host element is `[data-island="qr-flow"]` with:
 *   - data-sse-url      : EventSource endpoint (already query-encoded server-side)
 *   - data-auto         : "1" to open the SSE immediately on load; absent → wait
 *                         for a #startBtn click (Login enters a username first).
 *   - data-cookie-url    : (Authorize only) POST endpoint to set the tg_user hint
 *   - data-msg-connected : localized success heading
 *   - data-msg-added     : localized "account added" heading
 *   - data-msg-redirecting / data-msg-lost / data-msg-saved
 *
 * SSE events handled: `qr`, `status`, `connected` (login), `added` (add-account),
 * `redirect` (authorize → sets cookie then navigates), `error_msg`.
 *
 * The DOM contract matches the SSR markup: #qr-container, #status, #qr-section,
 * #intro/#login-form, #result.
 */
type Dict = Record<string, string>;

function jsonData(e: Event): Dict {
  try {
    return JSON.parse((e as MessageEvent).data) as Dict;
  } catch {
    return {};
  }
}

const root = document.querySelector<HTMLElement>('[data-island="qr-flow"]');
if (root) {
  const d = root.dataset;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`);
  const qrContainer = $("qr-container");
  const statusEl = $("status");
  const qrSection = $("qr-section");
  const intro = $("intro");
  const loginForm = $("login-form");
  const result = $("result");
  let es: EventSource | null = null;

  const hide = (el: HTMLElement | null) => {
    if (el) el.style.display = "none";
  };
  const show = (el: HTMLElement | null, display = "block") => {
    if (el) el.style.display = display;
  };
  const showResult = (html: string) => {
    hide(qrSection);
    if (result) {
      result.style.display = "block";
      result.innerHTML = html;
    }
  };
  const ok = (heading: string, body: string, note: string) =>
    `<div style="background:#F4F4F7;border:1px solid #007AFF;border-radius:12px;padding:20px;margin:20px 0">` +
    `<h2 style="color:#007AFF;font-size:20px;margin-bottom:8px">${heading}</h2><p>${body}</p>` +
    `<p style="margin-top:12px;font-size:13px;color:#707579">${note}</p></div>`;
  const fail = (msg: string) =>
    `<div style="background:#F4F4F7;border:1px solid #E53935;border-radius:12px;padding:20px;margin:20px 0"><p>${msg}</p></div>`;

  const peer = (data: Dict) => `${data.name || ""} (@${data.username || "unknown"})`;

  function start(): void {
    // Login builds its SSE URL from the typed username; other flows have a
    // ready URL in data-sse-url.
    let url = d.sseUrl ?? "";
    if (d.sseUrlTemplate) {
      const userId = root?.querySelector<HTMLInputElement>("#userId")?.value.trim();
      if (!userId) return;
      url = d.sseUrlTemplate.replace("{userId}", encodeURIComponent(userId));
    }
    hide(intro);
    hide(loginForm);
    show(qrSection);
    es = new EventSource(url);

    es.addEventListener("qr", (e) => {
      const data = jsonData(e);
      if (qrContainer) qrContainer.innerHTML = `<img src="${data.dataUrl}" alt="QR Code">`;
    });
    es.addEventListener("status", (e) => {
      const data = jsonData(e);
      if (statusEl) statusEl.textContent = data.message ?? "";
    });
    es.addEventListener("connected", (e) => {
      const data = jsonData(e);
      es?.close();
      showResult(ok(d.msgConnected ?? "Connected!", peer(data), d.msgSaved ?? ""));
    });
    es.addEventListener("added", (e) => {
      const data = jsonData(e);
      es?.close();
      const label = data.label ? ` — ${data.label}` : "";
      showResult(ok(d.msgAdded ?? "Account added", peer(data) + label, d.msgSaved ?? ""));
    });
    es.addEventListener("redirect", (e) => {
      const data = jsonData(e);
      es?.close();
      showResult(ok(d.msgConnected ?? "Connected!", peer(data), d.msgRedirecting ?? ""));
      const navigate = () => {
        if (data.url) window.location.href = data.url;
      };
      // Authorize: set the HttpOnly tg_user hint cookie, best-effort, then go.
      if (d.cookieUrl && data.username && data.username !== "unknown") {
        fetch(d.cookieUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: data.username }),
          credentials: "same-origin",
        })
          .then(navigate)
          .catch(navigate);
      } else {
        navigate();
      }
    });
    es.addEventListener("error_msg", (e) => {
      const data = jsonData(e);
      es?.close();
      showResult(fail(data.message ?? "Error"));
    });
    es.onerror = () => {
      if (statusEl) statusEl.textContent = d.msgLost ?? "Connection lost. Refresh to retry.";
    };
  }

  if (d.auto === "1") {
    start();
  } else {
    $("startBtn")?.addEventListener("click", start);
    // Login: Enter in the username field starts the flow.
    root.querySelector<HTMLInputElement>("#userId")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") start();
    });
  }
}

export {}; // island module scope — keeps top-level names out of the shared global compile scope
