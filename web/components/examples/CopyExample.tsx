"use client";

import { useState } from "react";
import { TbCheck, TbCopy } from "react-icons/tb";
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
      {copied ? <TbCheck size={16} aria-hidden /> : <TbCopy size={16} aria-hidden />}
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
