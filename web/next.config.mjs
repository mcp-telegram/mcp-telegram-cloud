import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import createNextIntlPlugin from "next-intl/plugin";

const __dirname = dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Pin Turbopack root to the monorepo root (one level up) so Bun-hoisted
  // node_modules at the workspace root are visible. Without this, Turbopack
  // either complains about a stray $HOME/package-lock.json or can't resolve
  // `next/package.json` because it's not under web/ directly.
  turbopack: { root: resolve(__dirname, "..") },
  async headers() {
    // React's dev runtime needs eval() for hot reload + better stack traces.
    // Production builds never use eval, so we only relax script-src in dev.
    const isDev = process.env.NODE_ENV !== "production";

    // Analytics CSP allowances — only widened when an analytics ID is set at
    // build time (same env that gates the <Analytics> mount). With no IDs the
    // CSP stays strict 'self'-only, keeping the OSS image locked down.
    //   Yandex.Metrika: mc.yandex.ru loads tag.js + sends hits; webvisor.org
    //     carries Webvisor session-replay payloads; img pixels go to *.yandex.ru.
    //   GA4: googletagmanager.com loads gtag.js; *.google-analytics.com receives
    //     the /g/collect hits (regionN. subdomain varies by visitor location).
    const analyticsEnabled = Boolean(
      (process.env.METRIKA_ID || "").trim() || (process.env.GA4_ID || "").trim(),
    );
    const metrikaScript = "https://mc.yandex.ru https://mc.webvisor.org https://mc.webvisor.com";
    const metrikaConnect =
      "https://mc.yandex.ru https://mc.webvisor.org https://mc.webvisor.com https://yandex.ru";
    const gaScript = "https://www.googletagmanager.com";
    const gaConnect =
      "https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com https://*.google-analytics.com";

    const scriptExtra = analyticsEnabled ? ` ${metrikaScript} ${gaScript}` : "";
    const connectExtra = analyticsEnabled ? ` ${metrikaConnect} ${gaConnect}` : "";

    const scriptSrc = `${isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'"}${scriptExtra}`;
    const securityHeaders = [
      {
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          `script-src ${scriptSrc}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          `connect-src 'self'${connectExtra}`,
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join("; "),
      },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
