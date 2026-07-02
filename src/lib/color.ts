/** Per-source colour assignment. */

import type { HSL } from '../types'

/** Format an HSL colour to a CSS `hsla()` string, with optional lightness delta. */
export const hsl = (c: HSL, a = 1, dl = 0): string =>
  `hsla(${c.h}, ${c.s}%, ${Math.max(0, Math.min(100, c.l + dl))}%, ${a})`

/**
 * A stateful hue generator that walks the colour wheel by the golden angle, so
 * successive sources get well-spaced, visually distinct hues.
 */
export function createColorGenerator(seed = Math.random() * 360) {
  let hue = seed
  return function nextColor(): HSL {
    const h = hue % 360
    hue += 137.508 // golden angle
    return { h: Math.round(h), s: 68, l: 56 }
  }
}
