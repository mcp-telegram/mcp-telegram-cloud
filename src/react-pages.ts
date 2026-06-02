import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { detectLocale } from "../app/src/i18n/index.js";

/**
 * Bridge between the Hono backend and the `app/` React pages.
 *
 * The `app/` workspace builds two outputs (see app/vite.*.config.ts):
 *   - `app/dist-ssr/<page>.js` — server bundles with React inlined; each
 *     exports `render(props) => string`. Imported here, run per request.
 *   - `app/dist/assets/*` + `app/dist/.vite/manifest.json` — hashed client
 *     island bundles, served as static files and referenced from the SSR HTML.
 *
 * This module resolves those paths, reads the client manifest once, and exposes
 * helpers the routes use. The backend itself never imports React — the SSR
 * bundles are self-contained (ssr.noExternal), so `src/`'s dependency set is
 * unchanged. See claudedocs/react-i18n-pages-migration.md.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// `src/react-pages.ts` → repo root is one level up.
const APP_DIR = join(HERE, "..", "app");
const SSR_DIR = join(APP_DIR, "dist-ssr");
const CLIENT_DIR = join(APP_DIR, "dist");
const MANIFEST_PATH = join(CLIENT_DIR, ".vite", "manifest.json");

type ManifestEntry = { file: string; name: string; isEntry?: boolean };
type Manifest = Record<string, ManifestEntry>;

let manifestCache: Manifest | null = null;

function loadManifest(): Manifest {
  if (manifestCache) return manifestCache;
  manifestCache = existsSync(MANIFEST_PATH) ? (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest) : {};
  return manifestCache;
}

/** True once `app build` has produced the bundles — lets the server degrade
 * gracefully (fall back to hono pages) if the app bundle is missing. */
export function reactPagesAvailable(): boolean {
  return existsSync(SSR_DIR) && existsSync(MANIFEST_PATH);
}

/**
 * Resolve the public URL(s) for an island entry, e.g. `"language-switcher"`.
 * Served under `/app-assets/` (see static route). Unknown island → empty list.
 */
export function islandScripts(...islandNames: string[]): string[] {
  const manifest = loadManifest();
  const urls: string[] = [];
  for (const name of islandNames) {
    const entry = manifest[`src/islands/${name}.tsx`];
    if (entry) urls.push(`/app-assets/${entry.file}`);
  }
  return urls;
}

/** Read a built client asset by its path relative to `app/dist` (for serving
 * `/app-assets/*`). Returns null if absent or path-escapes the asset dir. */
export function readClientAsset(relPath: string): string | null {
  // Reject traversal: the joined path must stay inside CLIENT_DIR.
  const full = join(CLIENT_DIR, relPath);
  if (!full.startsWith(`${CLIENT_DIR}/`) && full !== CLIENT_DIR) return null;
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

type RenderFn = (props: Record<string, unknown>) => string;

const renderCache = new Map<string, RenderFn>();

/**
 * Import a page's SSR bundle and return its `render` function. Cached after
 * first import. The dynamic import path is the built `dist-ssr/<page>.js`.
 */
async function loadRender(page: string): Promise<RenderFn> {
  const cached = renderCache.get(page);
  if (cached) return cached;
  const mod = (await import(join(SSR_DIR, `${page}.js`))) as { render: RenderFn };
  renderCache.set(page, mod.render);
  return mod.render;
}

/** Render a React page to a full HTML string. `props` is passed straight to
 * the page's `render`. The island scripts are injected by the page via its
 * `scripts` prop — pass them in `props.scripts`. */
export async function renderReactPage(page: string, props: Record<string, unknown>): Promise<string> {
  const render = await loadRender(page);
  return render(props);
}

const LOCALE_COOKIE = "tg_locale";

/** Pick the request's locale: the `tg_locale` cookie (set by the language
 * switcher) wins, else negotiate from `Accept-Language`, else default. Uses
 * the app's own `detectLocale` so the rules match the catalogs exactly. */
export function detectRequestLocale(c: Context): string {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)tg_locale=([^;]+)/);
  let cookieLocale: string | undefined;
  if (match) {
    try {
      cookieLocale = decodeURIComponent(match[1]);
    } catch {
      cookieLocale = undefined;
    }
  }
  return detectLocale(c.req.header("accept-language"), cookieLocale);
}

export { LOCALE_COOKIE };
