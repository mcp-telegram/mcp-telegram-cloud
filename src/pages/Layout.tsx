import { Style } from "hono/css";
import type { Child, FC } from "hono/jsx";
import { globalReset } from "../styles.js";

interface LayoutProps {
  title: string;
  description?: string;
  children: Child;
  globalCss?: string;
}

export const Layout: FC<LayoutProps> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {props.description && <meta name="description" content={props.description} />}
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <Style />
        <style dangerouslySetInnerHTML={{ __html: props.globalCss ?? globalReset }} />
      </head>
      <body>{props.children}</body>
    </html>
  );
};
