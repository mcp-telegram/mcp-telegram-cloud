import type { Metadata } from "next";
import type { ReactNode } from "react";
import { config, iconUrl } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(config.issuer),
  title: { default: config.brandName, template: `%s — ${config.brandName}` },
  description: "Connect your Telegram to Claude AI or ChatGPT. Read-only MCP connector.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    type: "website",
    siteName: config.brandName,
    images: [{ url: iconUrl }],
  },
  twitter: {
    card: "summary",
    images: [iconUrl],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
