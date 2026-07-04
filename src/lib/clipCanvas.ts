/** Canvas rendering for a timeline clip's filmstrip (video) or waveform (audio). */

import type { Clip, Source, Thumbnail } from '../types'
import { hsl } from './color'
import { dbToLinear } from './loudness'

/**
 * Draw a clip's decoration into its canvas. The backing resolution is capped at
 * 4096 px (a clip wider than the browser's max canvas size would fail to render
 * at all); the canvas is CSS-stretched to the clip's real width, so a long clip
 * just gets a slightly lower-res strip.
 */
export function drawClipDecoration(canvas: HTMLCanvasElement, clip: Clip, source: Source, isVideo: boolean): void {
  const H = Math.max(1, Math.round(canvas.clientHeight))
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, Math.round(canvas.clientWidth))
  const W = Math.min(cssW, 4096)

  canvas.width = Math.max(1, Math.round(W * dpr))
  canvas.height = Math.max(1, Math.round(H * dpr))
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  if (isVideo && source.thumbs && source.thumbs.length) {
    drawFilmstrip(ctx, W, H, clip, source)
  } else if (!isVideo && source.peaks && source.peaks.length) {
    drawWaveform(ctx, W, H, clip, source)
  }
}

function drawFilmstrip(ctx: CanvasRenderingContext2D, W: number, H: number, clip: Clip, src: Source): void {
  const thumbs = src.thumbs!
  const aspect = src.width && src.height ? src.width / src.height : 16 / 9
  const tileW = Math.max(24, H * aspect)
  const inP = clip.in
  const span = clip.dur || 1
  for (let x = 0; x < W; x += tileW) {
    const t = inP + ((x + tileW / 2) / W) * span
    const th = nearestThumb(thumbs, t)
    if (th) {
      try {
        ctx.drawImage(th.bitmap, x, 0, tileW, H)
      } catch {
        /* bitmap gone */
      }
    }
  }
  // subtle separators between frames
  ctx.strokeStyle = 'rgba(0,0,0,.35)'
  for (let x = tileW; x < W; x += tileW) {
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, 0)
    ctx.lineTo(Math.round(x) + 0.5, H)
    ctx.stroke()
  }
}

function nearestThumb(thumbs: Thumbnail[], t: number): Thumbnail | null {
  let best: Thumbnail | null = null
  let bd = Infinity
  for (const th of thumbs) {
    const d = Math.abs(th.timestamp_s - t)
    if (d < bd) {
      bd = d
      best = th
    }
  }
  return best
}

function drawWaveform(ctx: CanvasRenderingContext2D, W: number, H: number, clip: Clip, src: Source): void {
  const peaks = src.peaks!
  const total = src.duration || 1
  const inP = clip.in
  const span = clip.dur || 1
  const mid = H / 2
  // Reflect the clip's output gain in the wave's height, so lowering a clip's
  // level visibly shrinks its waveform (and raising it grows, up to full-height).
  const scale = dbToLinear(clip.gainDb)
  ctx.fillStyle = hsl(src.color, 0.85, 14)
  for (let x = 0; x < W; x++) {
    const t = inP + (x / W) * span
    const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor((t / total) * peaks.length)))
    const a = peaks[idx] || 0
    const h = Math.max(0.75, Math.min(mid, a * scale * mid * 0.9))
    ctx.fillRect(x, mid - h, 1, h * 2)
  }
}
