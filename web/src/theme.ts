// Light / dark / automatic (follow the device). Stored on this device; applied as
// <html data-theme="light|dark"> (no attribute = automatic).
import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "noty:theme";
const EVENT = "noty-theme";

export function getTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function setTheme(t: ThemeChoice) {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {}
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  dispatchEvent(new Event(EVENT));
}

/** Is the app showing dark right now (your choice, or the device's when automatic)? */
export function isDark(): boolean {
  const t = getTheme();
  return t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
}

/** Re-renders when the theme (or the device's setting, in automatic mode) changes. */
export function useTheme(): { choice: ThemeChoice; dark: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const on = () => tick((n) => n + 1);
    m.addEventListener("change", on);
    addEventListener(EVENT, on);
    return () => (m.removeEventListener("change", on), removeEventListener(EVENT, on));
  }, []);
  return { choice: getTheme(), dark: isDark() };
}
