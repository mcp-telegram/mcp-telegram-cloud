import { LOCALES } from "../i18n/index.js";

export type LanguageSwitcherProps = {
  /** Currently active locale code. */
  current: string;
  /** Localized label for the control (from `common.languageLabel`). */
  label: string;
};

/**
 * A plain `<select>` whose change handler is wired up at hydration time (see
 * `islands/language-switcher.tsx`). Rendering it as a real form control means
 * it's usable even before JS loads — picking an option does nothing until
 * hydrated, but the control is visible and accessible immediately (SSR-first).
 */
export function LanguageSwitcher({ current, label }: LanguageSwitcherProps) {
  return (
    <label data-island="language-switcher" style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
      <span style={{ fontSize: "13px", color: "#707579" }}>{label}</span>
      <select name="locale" defaultValue={current} aria-label={label}>
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nameNative}
          </option>
        ))}
      </select>
    </label>
  );
}
