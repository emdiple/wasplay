/**
 * Read a CSS custom property off `:root` at draw time. Canvas elements don't
 * inherit CSS, so canvas-drawn UI (ruler, analyzer) reads its theme colours
 * through this and redraws whenever the active theme changes.
 */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
