import { Icon } from "./icons";
import { setTheme, type ThemeChoice, useTheme } from "./theme";

const OPTIONS: { id: ThemeChoice; label: string; icon: keyof typeof Icon }[] = [
  { id: "system", label: "Automatic", icon: "auto" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
];

/** Automatic / Light / Dark, as three small buttons. */
export function ThemeSwitch() {
  const { choice } = useTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Appearance">
      {OPTIONS.map((o) => {
        const I = Icon[o.icon];
        return (
          <button key={o.id} type="button" role="radio" aria-checked={choice === o.id} className={choice === o.id ? "on" : ""} onClick={() => setTheme(o.id)} title={o.label}>
            <I size={16} />
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One icon button that cycles Automatic → Light → Dark (for the library's top bar). */
export function ThemeCycleButton() {
  const { choice, dark } = useTheme();
  const next: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
  const label = OPTIONS.find((o) => o.id === choice)!.label;
  const I = choice === "system" ? Icon.auto : dark ? Icon.moon : Icon.sun;
  return (
    <button type="button" className="icon-btn" onClick={() => setTheme(next[choice])} title={`Appearance: ${label} (tap to change)`} aria-label={`Appearance: ${label}. Change`}>
      <I />
    </button>
  );
}
