/** Card picker used on the Quickstart hub — both for the two platform cards
 * (Claude / ChatGPT, with brand logos) and the feature-guide cards below them
 * (with a tinted icon tile). Pure RSC — uses the locale-aware Link wrapper so
 * prefixes are added/stripped automatically under `localePrefix: 'as-needed'`. */

import type { IconType } from "react-icons";
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
  Icon: IconType;
  /** Brand colour for platform logos; guide icons use the link colour tile. */
  iconColor?: string;
};

export function PlatformTabs({ tabs, variant = "platform" }: { tabs: readonly Tab[]; variant?: "platform" | "guide" }) {
  return (
    <div className={variant === "guide" ? s.guides : s.tabs}>
      {tabs.map(({ href, title, description, cta, Icon, iconColor }) => (
        <Link key={href} href={href} className={variant === "guide" ? s.guide : s.tab}>
          {variant === "guide" ? (
            <span className={s.iconTile}>
              <Icon size={21} aria-hidden />
            </span>
          ) : (
            <Icon size={30} {...(iconColor ? { color: iconColor } : {})} aria-hidden />
          )}
          <h3 className={s.title}>{title}</h3>
          <p className={s.desc}>{description}</p>
          <span className={s.cta}>{cta}</span>
        </Link>
      ))}
    </div>
  );
}
