import { Style } from "hono/css";
import type { Child, FC } from "hono/jsx";
import { config, iconUrl } from "../config.js";
import { globalReset } from "../styles.js";

interface LayoutProps {
  title: string;
  description?: string;
  canonicalUrl?: string;
  children: Child;
  globalCss?: string;
}

export const Layout: FC<LayoutProps> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Functional-only host: keep out of search indexes (defense-in-depth
            alongside the global X-Robots-Tag header). */}
        <meta name="robots" content="noindex, nofollow" />
        <title>{props.title}</title>
        {props.description && <meta name="description" content={props.description} />}
        {props.canonicalUrl && <link rel="canonical" href={props.canonicalUrl} />}

        {/* Open Graph */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content={props.title} />
        {props.description && <meta property="og:description" content={props.description} />}
        <meta property="og:site_name" content={config.brandName} />
        {props.canonicalUrl && <meta property="og:url" content={props.canonicalUrl} />}
        <meta property="og:image" content={iconUrl} />

        {/* Twitter Card */}
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={props.title} />
        {props.description && <meta name="twitter:description" content={props.description} />}
        <meta name="twitter:image" content={iconUrl} />

        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <Style />
        <style dangerouslySetInnerHTML={{ __html: props.globalCss ?? globalReset }} />
      </head>
      <body>{props.children}</body>
    </html>
  );
};
