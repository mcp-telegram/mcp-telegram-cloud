"use client";

/** Read-only URL field with a copy button. Single client island — used inside
 * Quickstart pages so the connector URL can be copied with one click without
 * hydrating the rest of the page. */

import { useState } from "react";
import s from "./CopyableUrl.module.css";

type Props = {
  url: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
};

export function CopyableUrl({ url, label, copyLabel, copiedLabel }: Props) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={s.wrap}>
      <span className={s.label}>{label}</span>
      <input className={s.url} readOnly value={url} aria-label={label} />
      <button
        type="button"
        className={s.btn}
        data-copied={copied}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard write can fail in some browsers without HTTPS or with
            // tight permissions. Silently no-op — the URL is still selectable.
          }
        }}
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
