"use client";

/** Consent-gated analytics loader for the content site.
 *
 * Strict opt-in: neither Yandex.Metrika nor GA4 is loaded until the visitor
 * explicitly accepts in <ConsentBanner>. Until then this renders nothing and
 * sets no cookies. Once consent is granted (now, or persisted from a previous
 * visit via localStorage) the trackers mount via next/script.
 *
 * Consent state is shared with <ConsentBanner> through the `mcpt-consent`
 * localStorage key and a custom `mcpt-consent-change` window event, so the two
 * components stay in sync without a context provider.
 *
 * SPA navigation: next-intl's client router swaps routes without a full page
 * load, so we manually fire a pageview on each pathname change. */

import { usePathname } from "next/navigation";
import Script from "next/script";
import { useEffect, useState } from "react";
import { CONSENT_EVENT, CONSENT_KEY, readConsent } from "@/lib/consent";

type AnalyticsProps = {
  metrikaId: string;
  ga4Id: string;
};

declare global {
  interface Window {
    ym?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function Analytics({ metrikaId, ga4Id }: AnalyticsProps) {
  const [granted, setGranted] = useState(false);
  const pathname = usePathname();

  // Hydrate consent on mount + subscribe to changes from the banner. Reading
  // localStorage must happen client-side (post-mount) to avoid hydration drift.
  useEffect(() => {
    setGranted(readConsent() === "granted");
    const onChange = () => setGranted(readConsent() === "granted");
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONSENT_KEY) onChange();
    };
    window.addEventListener(CONSENT_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CONSENT_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Fire SPA pageviews on route change once trackers are live. The trackers'
  // own init snippets send the first pageview, and the global hooks (window.ym
  // / window.gtag) ignore calls before they load, so re-running on any dep
  // change is safe and idempotent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the SPA-navigation trigger — the effect reads window.location.href but must re-run on each route change.
  useEffect(() => {
    if (!granted) return;
    const url = window.location.href;
    if (metrikaId && window.ym) window.ym(Number(metrikaId), "hit", url);
    if (ga4Id && window.gtag) window.gtag("event", "page_view", { page_location: url });
  }, [pathname, granted, metrikaId, ga4Id]);

  if (!granted) return null;

  return (
    <>
      {metrikaId && (
        <Script id="yandex-metrika" strategy="afterInteractive">
          {`
            (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
            m[i].l=1*new Date();
            for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}
            k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
            (window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");
            ym(${Number(metrikaId)}, "init", {
              clickmap:true,
              trackLinks:true,
              accurateTrackBounce:true,
              webvisor:true
            });
          `}
        </Script>
      )}

      {ga4Id && (
        <>
          <Script
            id="ga4-loader"
            strategy="afterInteractive"
            src={`https://www.googletagmanager.com/gtag/js?id=${ga4Id}`}
          />
          <Script id="ga4-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              window.gtag = gtag;
              gtag('js', new Date());
              // Consent Mode v2 — visitor has granted; record it explicitly.
              gtag('consent', 'default', {
                ad_storage: 'denied',
                ad_user_data: 'denied',
                ad_personalization: 'denied',
                analytics_storage: 'denied'
              });
              gtag('consent', 'update', { analytics_storage: 'granted' });
              gtag('config', '${ga4Id}', { anonymize_ip: true });
            `}
          </Script>
        </>
      )}
    </>
  );
}
