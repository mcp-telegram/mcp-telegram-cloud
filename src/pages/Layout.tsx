import { Style } from "hono/css";
import type { Child, FC } from "hono/jsx";
import { globalReset } from "../styles.js";

interface LayoutProps {
  title: string;
  children: Child;
}

export const Layout: FC<LayoutProps> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <Style />
        <style dangerouslySetInnerHTML={{ __html: globalReset }} />
      </head>
      <body>{props.children}</body>
    </html>
  );
};
