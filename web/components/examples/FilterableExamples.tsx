"use client";

/** Category filter chips + the example grid.
 *
 * Cards arrive fully rendered from the server (RSC children can't be filtered
 * here), so this component takes plain data and renders ExampleCard itself.
 * Filtering is client-side over an already-loaded list of twelve — no fetching,
 * no URL state; the chips are a view toggle, not navigation. */

import { useState } from "react";
import { ExampleCard } from "./ExampleCard";
import s from "./FilterableExamples.module.css";

export type ExampleItem = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  category: string;
  categoryLabel: string;
};

type Props = {
  items: readonly ExampleItem[];
  /** Category id → chip label, in display order. */
  categories: readonly { id: string; label: string }[];
  allLabel: string;
  copyLabel: string;
  copiedLabel: string;
};

export function FilterableExamples({ items, categories, allLabel, copyLabel, copiedLabel }: Props) {
  const [active, setActive] = useState("all");
  const visible = active === "all" ? items : items.filter((item) => item.category === active);

  const chips = [{ id: "all", label: allLabel }, ...categories];

  return (
    <>
      <div className={s.filters}>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`${s.chip} ${active === chip.id ? s.chipActive : ""}`}
            aria-pressed={active === chip.id}
            onClick={() => setActive(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className={s.grid}>
        {visible.map((item) => (
          <ExampleCard
            key={item.id}
            title={item.title}
            description={item.description}
            prompt={item.prompt}
            category={item.categoryLabel}
            copyLabel={copyLabel}
            copiedLabel={copiedLabel}
          />
        ))}
      </div>
    </>
  );
}
