"use client";

import { useState } from "react";

type Props = { text: string; copyLabel: string; copiedLabel: string };

export function CopyExample({ text, copyLabel, copiedLabel }: Props) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      style={{
        padding: "6px 14px",
        background: "transparent",
        border: "1px solid currentColor",
        borderRadius: 6,
        color: copied ? "var(--tg-green)" : "var(--tg-link)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 500,
      }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard write can fail without HTTPS or with strict permissions.
        }
      }}
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
