import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.ISSUER || "https://mcp-telegram.com"),
  title: { default: "MCP Telegram", template: "%s — MCP Telegram" },
  description: "Connect your Telegram to Claude AI or ChatGPT. Read-only MCP connector.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
