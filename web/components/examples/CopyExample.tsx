"use client";

import { useState } from "react";
import s from "./CopyExample.module.css";

type Props = { text: string; copyLabel: string; copiedLabel: string };

export function CopyExample({ text, copyLabel, copiedLabel }: Props) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`${s.button} ${copied ? s.copied : ""}`}
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
