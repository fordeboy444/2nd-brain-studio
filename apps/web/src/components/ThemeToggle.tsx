import { useState } from "react";
import { currentTheme, setTheme, type Theme } from "../lib/theme.js";

/**
 * Light / dark / system toggle. Cycles the three preferences and reflects
 * the current value in an accessible label. Reads and writes ONLY through
 * `lib/theme.ts` — it never touches browser storage or the root element
 * directly (grep-verifiable).
 */
const ORDER: readonly Theme[] = ["light", "dark", "system"];

const LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());

  const cycle = () => {
    const idx = ORDER.indexOf(theme);
    const next = ORDER[(idx + 1) % ORDER.length] ?? "system";
    setTheme(next);
    setThemeState(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[theme]}. Click to change.`}
      title={`Theme: ${LABEL[theme]}`}
    >
      <span aria-hidden="true">{LABEL[theme]}</span>
    </button>
  );
}