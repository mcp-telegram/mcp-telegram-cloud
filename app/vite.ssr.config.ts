import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Server-side render bundle. Distinct from `vite.config.ts` (client islands).
 *
 * Each page module exports a `render(props) => string` that the Bun backend
 * imports from `dist-ssr/` and calls per request. React is bundled IN
 * (`ssr.noExternal`) so the backend stays free of a react dependency — its
 * runtime deps remain the original six. The SSR bundle is large (~1MB) but
 * server-only; it is never sent to the browser. Verified: a backend with no
 * react in its deps imports this output and renders HTML.
 *
 * See claudedocs/react-i18n-pages-migration.md for the full rationale.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    ssr: true,
    outDir: "dist-ssr",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: "src/pages/settings.tsx",
        audit: "src/pages/audit.tsx",
        uploads: "src/pages/uploads.tsx",
        "add-account": "src/pages/add-account.tsx",
        login: "src/pages/login.tsx",
        authorize: "src/pages/authorize.tsx",
      },
      output: { format: "esm", entryFileNames: "[name].js" },
    },
  },
  ssr: { noExternal: ["react", "react-dom"] },
});
