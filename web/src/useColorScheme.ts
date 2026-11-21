import { useTheme } from "./theme";

/** "light" or "dark", following the theme chosen in Noty (or the device, when automatic). */
export function useColorScheme(): "light" | "dark" {
  return useTheme().dark ? "dark" : "light";
}
