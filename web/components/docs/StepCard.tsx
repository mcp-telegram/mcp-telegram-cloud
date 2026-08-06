/** RSC-rendered numbered step card. Used in Quickstart guides.
 *
 * `image` is optional — Phase 3 ships without screenshots; once the user
 * captures Claude.ai/ChatGPT UI screenshots into `web/public/docs/` we
 * pass the src here. Until then the placeholder slot is empty. */

import type { ReactNode } from "react";
import s from "./StepCard.module.css";

type Props = {
  num: number;
  title: string;
  description: string;
  image?: string;
  imageAlt?: string;
  children?: ReactNode;
};

/** Wrapper for a run of StepCards. Required — the connector line between steps
 * is drawn relative to this element, not to the page. */
export function Stepper({ children }: { children: ReactNode }) {
  return <div className={s.stepper}>{children}</div>;
}

export function StepCard({ num, title, description, image, imageAlt, children }: Props) {
  return (
    <div className={s.card}>
      <div className={s.num}>{num}</div>
      <div className={s.body}>
        <h2 className={s.title}>{title}</h2>
        <p className={s.desc}>{description}</p>
        {children}
        {image ? (
          // biome-ignore lint/performance/noImgElement: served from /public/docs/, no domain optimisation needed.
          <img className={s.image} src={image} alt={imageAlt ?? title} loading="lazy" />
        ) : null}
      </div>
    </div>
  );
}
