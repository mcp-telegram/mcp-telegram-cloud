"use client";

/** Landing FAQ accordion — one panel open at a time, the first open initially.
 *
 * Answers can carry links/code, so each item supplies a ReactNode rather than a
 * plain string. Built on native <button> + aria-expanded/aria-controls instead
 * of <details> so the single-open behaviour and the chevron rotation are driven
 * by the same state. */

import type { ReactNode } from "react";
import { useId, useState } from "react";
import { TbChevronDown } from "react-icons/tb";
import s from "@/app/landing.module.css";

export type FaqEntry = { question: string; answer: ReactNode };

export function FaqAccordion({ items }: { items: FaqEntry[] }) {
  const [open, setOpen] = useState(0);
  const baseId = useId();

  return (
    <div className={s.faqList}>
      {items.map((item, i) => {
        const isOpen = open === i;
        const panelId = `${baseId}-panel-${i}`;
        const buttonId = `${baseId}-button-${i}`;
        return (
          <div key={item.question} className={s.faqItem}>
            <button
              type="button"
              id={buttonId}
              className={s.faqQuestion}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpen(isOpen ? -1 : i)}
            >
              {item.question}
              <TbChevronDown size={20} aria-hidden className={`${s.faqChevron} ${isOpen ? s.faqChevronOpen : ""}`} />
            </button>
            {isOpen && (
              <section id={panelId} aria-labelledby={buttonId} className={s.faqAnswer}>
                {item.answer}
              </section>
            )}
          </div>
        );
      })}
    </div>
  );
}
