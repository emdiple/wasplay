/**
 * renderVideo.ts — produce encoded video chunks for the timeline.
 *
 * For each output frame, composite the topmost clip (by z-order) onto an
 * OffscreenCanvas over black and feed it to a WebCodecs VideoEncoder. Frames for
 * each source come from a FrameSource, which is the fast demux + VideoDecoder
 * path when the browser can decode the source, or a <video>-seek fallback
 * otherwise (see frameSource.ts). Only the *encode* is always WebCodecs.
 */

import type { EdlEvent } from '../wasm/foxEdl'
import { createFrameSource, type FrameSource } from './frameSource'
import type { Source } from '../types'

/** The video event covering time `t`, topmost by z (events must be z-ascending). */
function topmostAt(events: EdlEvent[], t: number): EdlEvent | null {
  let hit: EdlEvent | null = null
  for (const ev of events) {
    if (t >= ev.timeline_in_s && t < ev.timeline_out_s) hit = ev // later match = higher z
  }
  return hit
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
  onProgress,
  signal,
}: RenderVideoArgs): Promise<void> {
  const frameSources = await loadFrameSources(events, sources)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  const frameDur = 1_000_000 / fps
  const keyEvery = Math.max(1, Math.round(fps * 2))
  const totalFrames = Math.max(1, Math.round(totalDuration * fps))

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
      const t = f / fps

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      const ev = topmostAt(events, t)
      if (ev) {
        const fs = frameSources.get(ev.source_id)
        if (fs) {
          const img = await fs.getFrame(ev.source_in_s + (t - ev.timeline_in_s))
          if (img) {
            const [iw, ih] = fs.dims()
            drawContain(ctx, img, iw, ih, width, height)
          }
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
