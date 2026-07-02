/** Time / timecode formatting helpers. */

export const pad = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM:SS.cs` timecode (centisecond precision). */
export function formatTC(seconds: number): string {
  const s = Math.max(0, seconds || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const cs = Math.floor((s * 100) % 100)
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(cs)}`
}

/** Compact `M:SS` / `H:MM:SS` clock label for ruler ticks. */
export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const sec = Math.floor(seconds % 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** `M:SS` / `H:MM:SS` label used on thumbnail overlays. */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
