/**
 * renderVideo.ts — produce encoded video chunks for the timeline.
 *
 * For each output frame, composite the topmost clip (by z-order) onto an
 * OffscreenCanvas over black and feed it to a WebCodecs VideoEncoder. Frames for
 * each source come from a FrameSource, which is the fast demux + VideoDecoder
 * path when the browser can decode the source, or a <video>-seek fallback
 * otherwise (see frameSource.ts). Only the *encode* is always WebCodecs.
 */

import type { EdlEvent } from '../wasm/wazEdl'
import { createFrameSource, type FrameSource } from './frameSource'
import { fadeGain } from '../lib/fade'
import type { Source } from '../types'

/** Per-clip fade envelope (seconds) keyed by clip id; missing → no fade. */
export type FadesByClip = Map<string, { fadeIn: number; fadeOut: number }>

/**
 * Dissolves keyed by the incoming clip's id. The outgoing clip is resolved by
 * the caller (exportProject) against the store's tracks — a dissolve is a
 * same-layer construct, and the EDL events carry no track info to re-derive it.
 */
export type TransByClip = Map<string, { dur: number; fromClipId: string }>

/** A resolved cross-dissolve window: blend `from` → `to` across [start, end). */
interface TransitionWindow {
  from: EdlEvent
  to: EdlEvent
  start: number
  end: number
}

/** The video event covering time `t`, topmost by z (events must be z-ascending). */
function topmostAt(events: EdlEvent[], t: number): EdlEvent | null {
  let hit: EdlEvent | null = null
  for (const ev of events) {
    if (t >= ev.timeline_in_s && t < ev.timeline_out_s) hit = ev // later match = higher z
  }
  return hit
}

/** Pair each tagged incoming event with its outgoing event, by clip id. */
function transitionWindows(events: EdlEvent[], transByClip: TransByClip): TransitionWindow[] {
  const byId = new Map(events.map((e) => [e.clip_id, e]))
  const out: TransitionWindow[] = []
  for (const [toId, { dur, fromClipId }] of transByClip) {
    const to = byId.get(toId)
    const from = byId.get(fromClipId)
    if (to && from && dur > 0) out.push({ from, to, start: to.timeline_in_s, end: to.timeline_in_s + dur })
  }
  return out
}

/** Draw an image into WxH preserving aspect ratio (letterbox/pillarbox). */
function drawContain(
  ctx: OffscreenCanvasRenderingContext2D,
  img: CanvasImageSource,
  iw: number,
  ih: number,
  W: number,
  H: number,
): void {
  if (!iw || !ih) return
  const scale = Math.min(W / iw, H / ih)
  const dw = iw * scale
  const dh = ih * scale
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

async function loadFrameSources(events: EdlEvent[], sources: Source[]): Promise<Map<string, FrameSource>> {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const ids = [...new Set(events.map((e) => e.source_id))]
  const map = new Map<string, FrameSource>()
  await Promise.all(
    ids.map(async (id) => {
      const src = byId.get(id)
      if (src) map.set(id, await createFrameSource(src))
    }),
  )
  return map
}

const drainQueue = async (encoder: VideoEncoder, target: number) => {
  while (encoder.encodeQueueSize > target) await new Promise((r) => setTimeout(r, 4))
}

export interface RenderVideoArgs {
  events: EdlEvent[]
  sources: Source[]
  width: number
  height: number
  fps: number
  totalDuration: number
  encoder: VideoEncoder
  /** Per-clip fade envelopes (seconds); missing clip → no fade. */
  fadesByClip?: FadesByClip
  /** Per-clip dissolve lengths (seconds); drives the two-source crossfade blend. */
  transByClip?: TransByClip
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** Encode the whole video timeline into `encoder`, then flush it. */
export async function renderVideo({
  events,
  sources,
  width,
  height,
  fps,
  totalDuration,
  encoder,
  fadesByClip,
  transByClip,
  onProgress,
  signal,
}: RenderVideoArgs): Promise<void> {
  // topmostAt scans in array order — guarantee z-ascending whatever the EDL sent.
  events = [...events].sort((a, b) => a.z - b.z)
  const frameSources = await loadFrameSources(events, sources)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  const frameDur = 1_000_000 / fps
  const keyEvery = Math.max(1, Math.round(fps * 2))
  const totalFrames = Math.max(1, Math.round(totalDuration * fps))
  const windows = transByClip ? transitionWindows(events, transByClip) : []

  // Composite one event's frame onto the canvas at `alpha`, letterboxed.
  const drawEvent = async (ev: EdlEvent, t: number, alpha: number) => {
    const fs = frameSources.get(ev.source_id)
    if (!fs || alpha <= 0) return
    const img = await fs.getFrame(ev.source_in_s + (t - ev.timeline_in_s))
    if (!img) return
    const [iw, ih] = fs.dims()
    ctx.globalAlpha = alpha
    drawContain(ctx, img, iw, ih, width, height)
    ctx.globalAlpha = 1
  }

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
      const t = f / fps

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)

      const ev = topmostAt(events, t)
      if (ev) {
        // A dissolve only shows when one of its two clips is what's on top —
        // a clip on a higher layer covering this moment wins over the blend.
        const win = windows.find(
          (w) => t >= w.start && t < w.end && (w.to.clip_id === ev.clip_id || w.from.clip_id === ev.clip_id),
        )
        if (win) {
          // Cross-dissolve: the outgoing clip is the backdrop, the incoming clip
          // is drawn over it at rising alpha (fades from/to black don't apply here).
          const p = (t - win.start) / (win.end - win.start)
          await drawEvent(win.from, t, 1)
          await drawEvent(win.to, t, p)
        } else {
          // Fade in/out toward the black background (globalAlpha=1 = no-op).
          const fade = fadesByClip?.get(ev.clip_id)
          const alpha = fade
            ? fadeGain(t - ev.timeline_in_s, ev.timeline_out_s - ev.timeline_in_s, fade.fadeIn, fade.fadeOut)
            : 1
          await drawEvent(ev, t, alpha)
        }
      }

      const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1_000_000), duration: Math.round(frameDur) })
      encoder.encode(frame, { keyFrame: f % keyEvery === 0 })
      frame.close()

      if (encoder.encodeQueueSize > 8) await drainQueue(encoder, 4)
      onProgress?.(f + 1, totalFrames)
    }
    await encoder.flush()
  } finally {
    for (const fs of frameSources.values()) fs.close()
  }
}
