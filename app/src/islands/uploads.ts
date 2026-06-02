/**
 * Hydration island for the Uploads page: drag-and-drop / click-to-choose file
 * upload via XHR, a live status line, and copy-to-clipboard for upload IDs.
 *
 * Progressive enhancement — the SSR'd markup is fully present; this script just
 * wires behavior. Localized status strings are read from `data-*` attributes
 * the server rendered (so the island stays language-agnostic). On success it
 * reloads to show the new row (matching the legacy behavior).
 */
type Strings = {
  uploading: string;
  uploaded: string;
  failed: string;
  networkError: string;
  copied: string;
};

function getStrings(el: HTMLElement): Strings {
  return {
    uploading: el.dataset.msgUploading ?? "Uploading…",
    uploaded: el.dataset.msgUploaded ?? "Uploaded.",
    failed: el.dataset.msgFailed ?? "Upload failed",
    networkError: el.dataset.msgNetwork ?? "Network error",
    copied: el.dataset.msgCopied ?? "copied",
  };
}

const root = document.querySelector<HTMLElement>('[data-island="uploads"]');
if (root) {
  const s = getStrings(root);
  const dz = root.querySelector<HTMLElement>("#dz");
  const input = root.querySelector<HTMLInputElement>("#file-input");
  const statusEl = root.querySelector<HTMLElement>("#upload-status");

  const setStatus = (msg: string, isErr = false): void => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = isErr ? "#E53935" : "#707579";
  };

  const upload = (file: File | null | undefined): void => {
    if (!file) return;
    setStatus(`${s.uploading} ${file.name} (${Math.round(file.size / 1024)} KB)`);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/my/upload", true);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const resp = JSON.parse(xhr.responseText) as { id: string };
          setStatus(`${s.uploaded} ${resp.id}`);
          setTimeout(() => window.location.reload(), 600);
        } catch {
          setStatus(s.failed, true);
        }
      } else {
        let msg = `${s.failed} (${xhr.status})`;
        try {
          const resp = JSON.parse(xhr.responseText) as { message?: string };
          if (resp?.message) msg = resp.message;
        } catch {
          // keep generic message
        }
        setStatus(msg, true);
      }
    };
    xhr.onerror = () => setStatus(s.networkError, true);
    const fd = new FormData();
    fd.append("file", file, file.name);
    xhr.send(fd);
  };

  dz?.addEventListener("click", () => input?.click());
  input?.addEventListener("change", () => upload(input.files?.[0]));
  for (const ev of ["dragenter", "dragover"]) {
    dz?.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragging");
    });
  }
  for (const ev of ["dragleave", "drop"]) {
    dz?.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragging");
    });
  }
  dz?.addEventListener("drop", (e) => {
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) upload(f);
  });

  // Copy-to-clipboard for upload IDs (event delegation).
  root.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.dataset.copyId) return;
    navigator.clipboard.writeText(t.dataset.copyId).then(() => {
      const orig = t.textContent;
      t.textContent = s.copied;
      setTimeout(() => {
        t.textContent = orig;
      }, 1200);
    });
  });
}

export {}; // island module scope — keeps top-level names out of the shared global compile scope
