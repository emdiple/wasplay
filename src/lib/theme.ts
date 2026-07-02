/** Light/dark theme helpers: persistence (localStorage) + OS-preference default. */

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'shadowfox-theme'

/** The user's saved manual choice, or null if they've never toggled. */
export function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null
  }
}

/** The OS-level preference (defaults to dark when unknown). */
export function osTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* storage unavailable (private mode / disabled) — theme just won't persist */
  }
}

/** Initial theme: the saved choice if any, otherwise follow the OS. */
export function initialTheme(): Theme {
  return readStoredTheme() ?? osTheme()
}
