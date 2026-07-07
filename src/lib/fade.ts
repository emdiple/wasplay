/**
 * Pure fade math — the linear envelope a clip's fade-in / fade-out apply to both
 * picture (alpha over black) and sound (gain over silence). Kept framework-free
 * so the export renderers (renderVideo/renderAudio) and any future preview
 * compositor share one definition.
 */

/** Longest a single fade may be, in seconds — a guardrail for the UI inputs. */
export const FADE_MAX_S = 10

/**
 * Clamp a clip's requested fade-in/out to non-negative values that fit inside its
 * own duration. When both fades together exceed `dur`, the fade-in keeps its
 * length and the fade-out is trimmed to whatever remains, so they never cross.
 */
export function clampFades(
  dur: number,
  fadeIn = 0,
  fadeOut = 0,
): { fadeIn: number; fadeOut: number } {
  const fin = Math.max(0, Math.min(fadeIn, dur))
  const fout = Math.max(0, Math.min(fadeOut, Math.max(0, dur - fin)))
  return { fadeIn: fin, fadeOut: fout }
}

/**
 * The fade multiplier in [0,1] at local time `localT` (seconds from the clip's
 * left edge) for a clip of length `dur`. 1 in the steady middle; ramps linearly
 * over the fade-in and fade-out windows.
 */
export function fadeGain(localT: number, dur: number, fadeIn = 0, fadeOut = 0): number {
  const { fadeIn: fin, fadeOut: fout } = clampFades(dur, fadeIn, fadeOut)
  let g = 1
  if (fin > 0 && localT < fin) g = Math.min(g, localT / fin)
  if (fout > 0 && localT > dur - fout) g = Math.min(g, (dur - localT) / fout)
  return Math.max(0, Math.min(1, g))
}
