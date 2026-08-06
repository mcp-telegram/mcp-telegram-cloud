"use client";

/** Troubleshooting accordion for doc pages.
 *
 * Same interaction as the landing FAQ (one panel open at a time) but starts
 * fully collapsed — on a doc page these are exceptions, not the main content.
 * Kept separate from FaqAccordion because that one styles itself from
 * landing.module.css and defaults its first item open. */

import { useId, useState } from "react";
import { TbChevronDown } from "react-icons/tb";
import s from "./Troubleshooting.module.css";

export type TroubleItem = { title: string; body: string };

export function Troubleshooting({ items }: { items: readonly TroubleItem[] }) {
  const [open, setOpen] = useState(-1);
  const baseId = useId();

  return (
    <div className={s.list}>
      {items.map((item, i) => {
        const isOpen = open === i;
        const panelId = `${baseId}-panel-${i}`;
        const buttonId = `${baseId}-button-${i}`;
        return (
          <div key={item.title} className={s.item}>
            <button
              type="button"
              id={buttonId}
              className={s.question}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpen(isOpen ? -1 : i)}
            >
              {item.title}
              <TbChevronDown size={19} aria-hidden className={`${s.chevron} ${isOpen ? s.chevronOpen : ""}`} />
            </button>
            {isOpen && (
              <section id={panelId} aria-labelledby={buttonId} className={s.answer}>
                {item.body}
              </section>
            )}
          </div>
        );
      })}
    </div>
  );
}
