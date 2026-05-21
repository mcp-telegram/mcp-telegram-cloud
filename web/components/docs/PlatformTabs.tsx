/** Two-CTA platform picker for Quickstart overview. Pure RSC — uses the
 * locale-aware Link wrapper so prefixes are added/stripped automatically
 * under `localePrefix: 'as-needed'`. */

import { Link } from "@/i18n/navigation";
import s from "./PlatformTabs.module.css";

type Tab = {
  href:
    | "/docs/quickstart/claude"
    | "/docs/quickstart/chatgpt"
    | "/docs/multi-account"
    | "/docs/stories"
    | "/docs/uploads";
  title: string;
  description: string;
  cta: string;
};

export function PlatformTabs({ tabs }: { tabs: readonly Tab[] }) {
  return (
    <div className={s.tabs}>
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={s.tab}>
          <h3 className={s.title}>{tab.title}</h3>
          <p className={s.desc}>{tab.description}</p>
          <span className={s.cta}>{tab.cta}</span>
        </Link>
      ))}
    </div>
  );
}
