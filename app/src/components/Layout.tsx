import type { ReactNode } from "react";
import { isRtl } from "../i18n/index.js";

export type LayoutProps = {
  title: string;
  locale: string;
  description?: string | undefined;
  /** Hashed island bundle URLs to load (resolved from the Vite client manifest). */
  scripts?: readonly string[] | undefined;
  /** Raw CSS injected into <head> (Telegram design tokens etc.). */
  css?: string | undefined;
  children: ReactNode;
};

/**
 * Document shell for the React backend pages. Mirrors the old hono Layout:
 * functional-only host, so `noindex` is baked in (defense-in-depth alongside
 * the server's X-Robots-Tag header). `lang`/`dir` are locale-aware so RTL
 * locales (ar, he) render correctly.
 */
export function Layout({ title, locale, description, scripts, css, children }: LayoutProps) {
  return (
    <html lang={locale} dir={isRtl(locale) ? "rtl" : "ltr"}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{title}</title>
        {description ? <meta name="description" content={description} /> : null}
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        {css ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-controlled design-token CSS string, never user input.
          <style dangerouslySetInnerHTML={{ __html: css }} />
        ) : null}
      </head>
      <body>
        {children}
        {scripts?.map((src) => (
          <script key={src} type="module" src={src} defer />
        ))}
      </body>
    </html>
  );
}
