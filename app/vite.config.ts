import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite builds ONLY the client-side island bundles for hydration.
 *
 * Server-side rendering is done by the Bun backend directly: it imports the
 * page `.tsx` components and calls `react-dom/server`'s `renderToString`
 * (Bun executes TSX natively, no bundling needed for SSR). So Vite's job is
 * narrow — emit hashed JS for the interactive islands that the SSR'd HTML
 * references via <script src>. Output lands in `dist/assets/` and is served
 * by the backend under `/app-assets/*` (a dedicated-host route, so no Traefik
 * prefix-list change — see claudedocs/react-i18n-pages-migration.md NFR3).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    manifest: true,
    rollupOptions: {
      // Each island is its own entry so a page loads only the JS it needs.
      // More islands (qr-login, uploads, settings) land as pages migrate.
      input: {
        "language-switcher": "src/islands/language-switcher.tsx",
      },
    },
  },
});
