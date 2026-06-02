"use client";

/** Cookie-consent banner for the content site.
 *
 * Strict opt-in: shown until the visitor picks Accept or Decline. The choice
 * persists in localStorage (see lib/consent) so the banner never re-appears.
 * On Accept, <Analytics> picks up the change and mounts the trackers; on
 * Decline nothing loads.
 *
 * Renders nothing until mount (avoids a hydration flash) and nothing once a
 * decision exists. Styled with the shared --tg-* design tokens, fixed to the
 * bottom of the viewport, keyboard-reachable, and i18n via the `consent`
 * namespace. */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { readConsent, writeConsent } from "@/lib/consent";

export function ConsentBanner() {
  const t = useTranslations("consent");
  const [decided, setDecided] = useState(true); // assume decided until mount

  useEffect(() => {
    setDecided(readConsent() !== null);
  }, []);

  if (decided) return null;

  const decide = (value: "granted" | "denied") => {
    writeConsent(value);
    setDecided(true);
  };

  return (
    <div
      role="dialog"
      aria-label={t("title")}
      aria-live="polite"
      style={{
        position: "fixed",
        left: 16,
        right: 16,
        bottom: 16,
        zIndex: 1000,
        maxWidth: 720,
        margin: "0 auto",
        background: "var(--tg-card-bg)",
        color: "var(--tg-text)",
        border: "1px solid var(--tg-divider)",
        borderRadius: 12,
        boxShadow: "var(--tg-card-shadow)",
        padding: "16px 18px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <p style={{ flex: "1 1 280px", margin: 0, color: "var(--tg-hint)" }}>
        <strong style={{ color: "var(--tg-text)" }}>{t("title")}</strong> {t("text")}{" "}
        <Link href="/privacy" style={{ color: "var(--tg-link)", textDecoration: "underline" }}>
          {t("privacyLink")}
        </Link>
      </p>
      <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
        <button
          type="button"
          onClick={() => decide("denied")}
          style={{
            appearance: "none",
            border: "1px solid var(--tg-divider)",
            background: "transparent",
            color: "var(--tg-text)",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          {t("decline")}
        </button>
        <button
          type="button"
          onClick={() => decide("granted")}
          style={{
            appearance: "none",
            border: "none",
            background: "var(--tg-button)",
            color: "var(--tg-button-text)",
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("accept")}
        </button>
      </div>
    </div>
  );
}
