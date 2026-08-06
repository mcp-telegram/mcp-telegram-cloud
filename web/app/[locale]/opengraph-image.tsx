/** Social preview card, generated per locale.
 *
 * Covers every page under [locale] — Next.js emits og:image / twitter:image
 * tags automatically, and a page's own `openGraph` block in generateMetadata
 * no longer has to remember to carry the image along.
 *
 * Rendered with ImageResponse (satori), which supports only a subset of CSS:
 * every element needs an explicit `display`, there is no `gap` on block
 * layouts, and CSS variables are not resolved — hence the literal colours
 * below, kept in sync with the --tg-* tokens in globals.css by hand.
 *
 * No custom font is loaded on purpose: bundling a TTF would add weight to the
 * standalone image for a card that reads fine in the default sans-serif. */

import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";
import { config } from "@/lib/config";

export const alt = "Telegram MCP Server";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Props = { params: Promise<{ locale: string }> };

/** Scripts whose shaping satori cannot do with the default font stack.
 *
 * Arabic needs GSUB lookupType 5 / substFormat 3 for its contextual forms;
 * satori throws on that, which would turn the card into a 500 and leave the
 * page with no preview at all. Those locales fall back to the English
 * headline — "Telegram MCP Server" is a latin technical term everywhere
 * anyway (see the SEO work in 3890a86). */
const UNSHAPEABLE_LOCALES = new Set(["ar"]);

export default async function OpengraphImage({ params }: Props) {
  const { locale } = await params;
  const imageLocale = UNSHAPEABLE_LOCALES.has(locale) ? "en" : locale;
  const t = await getTranslations({ locale: imageLocale, namespace: "hero" });

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background: "linear-gradient(135deg, #2f9bff 0%, #0064d0 100%)",
        color: "#ffffff",
        fontFamily: "sans-serif",
      }}
    >
      {/* Brand row */}
      <div style={{ display: "flex", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 64,
            height: 64,
            borderRadius: 18,
            background: "rgba(255,255,255,0.18)",
            marginRight: 20,
          }}
        >
          {/* Paper plane, inlined: satori cannot fetch assets. No <title> here —
           * satori renders it as visible text rather than treating it as the
           * accessible name, which would print a label across the glyph. */}
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: rendered to a raster image; the card's alt text describes it. */}
          <svg width="36" height="36" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M21.9 2.6c.4-.9-.5-1.8-1.4-1.4L1.7 9.4c-1 .4-.9 1.9.2 2.1l4.9 1.2 1.9 6.1c.3.9 1.4 1.1 2 .4l2.7-2.9 4.7 3.5c.7.5 1.7.1 1.9-.7L21.9 2.6zM8.6 13.2l8.8-6.4-6.6 7.3c-.2.2-.3.4-.3.7l-.3 2.7-1.6-4.3z" />
          </svg>
        </div>
        <div style={{ display: "flex", fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>{config.brandName}</div>
      </div>

      {/* Headline — same wording as the page hero. */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 68,
            fontWeight: 800,
            lineHeight: 1.12,
            letterSpacing: -2,
            maxWidth: 940,
          }}
        >
          {`${t("titleStart")} ${t("titleClaude")} ${t("titleAnd")} ${t("titleChatGPT")}`}
        </div>
        <div style={{ display: "flex", marginTop: 26, fontSize: 30, opacity: 0.92 }}>Telegram MCP Server</div>
      </div>

      {/* Footer chips */}
      <div style={{ display: "flex", alignItems: "center" }}>
        {["MCP", "MTProto", "Open Source", "MIT"].map((chip) => (
          <div
            key={chip}
            style={{
              display: "flex",
              padding: "10px 22px",
              marginRight: 12,
              borderRadius: 100,
              background: "rgba(255,255,255,0.18)",
              fontSize: 24,
              fontWeight: 600,
            }}
          >
            {chip}
          </div>
        ))}
      </div>
    </div>,
    size,
  );
}
