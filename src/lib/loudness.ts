/**
 * loudness.ts — shared EBU R128 loudness helpers.
 *
 * Sources are measured once at import (integrated LUFS, stored on the Source);
 * the user then sets a per-source output gain in dB that the audio renderer
 * applies on export. "Normalize" just presets that gain to hit a target LUFS.
 */

/** Common integrated-loudness targets, by delivery context. */
export const LUFS_TARGETS: { label: string; value: number }[] = [
  { label: 'Streaming (−14)', value: -14 },
  { label: 'Podcast (−16)', value: -16 },
  { label: 'Broadcast (−23)', value: -23 },
]

export const DEFAULT_TARGET_LUFS = -14

/** Sensible bounds for a user-set normalize target (LUFS). */
export const TARGET_MIN_LUFS = -40
export const TARGET_MAX_LUFS = -6
export const clampTargetLufs = (v: number): number =>
  Number.isFinite(v) ? Math.min(TARGET_MAX_LUFS, Math.max(TARGET_MIN_LUFS, v)) : DEFAULT_TARGET_LUFS

/** Gain knob range, in dB. */
export const GAIN_MIN_DB = -24
export const GAIN_MAX_DB = 24

export const clampGainDb = (db: number): number => Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db))

/** Linear amplitude multiplier for a dB gain (0 dB → 1.0). */
export const dbToLinear = (db: number): number => Math.pow(10, db / 20)

/** dB gain needed to move `lufs` to `target` (clamped to the knob range). */
export const gainToTarget = (lufs: number, target: number): number => clampGainDb(target - lufs)

/** Estimated integrated loudness after applying `gainDb` (gain shifts LUFS 1:1). */
export const outputLufs = (lufs: number, gainDb: number): number => lufs + gainDb

/** A finite, real measurement (not silence / not-yet-measured). */
export const hasMeasuredLoudness = (lufs: number | null | undefined): lufs is number =>
  lufs != null && Number.isFinite(lufs)

/** Format a LUFS value for display (−∞ for silence/no measurement). */
export const formatLufs = (lufs: number | null | undefined): string =>
  hasMeasuredLoudness(lufs) ? `${lufs.toFixed(1)} LUFS` : '−∞'

/** Format a dB gain with an explicit sign (e.g. "+4.2 dB", "0.0 dB"). */
export const formatGain = (db: number): string => `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
