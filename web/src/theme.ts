import type { ThemePreference } from "./types.js"

export function normalizeThemePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system"
}
