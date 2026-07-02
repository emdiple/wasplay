/**
 * renderVideo.ts — produce encoded video chunks for the timeline.
 *
 * Decode strategy: drive one hidden `<video>` element per source and seek it to
 * each output frame's timestamp (native, cross-browser, no demuxer needed);
 * composite the topmost clip onto an OffscreenCanvas over black; feed each frame
 * to a WebCodecs `VideoEncoder`. Only the *encode* is WebCodecs — the decode is
 * the browser's native video pipeline.
 */

import type { EdlEvent } from '../wasm/foxEdl'
import { getObjectUrl } from '../lib/objectUrlCache'
import type { Source } from '../types'

/** The video event covering time `t`, topmost by z (events must be z-ascending). */
function topmostAt(events: EdlEvent[], t: number): EdlEvent | null {
  let hit: EdlEvent | null = null
  for (const ev of events) {
    if (t >= ev.timeline_in_s && t < ev.timeline_out_s) hit = ev // later match = higher z
  }
  return hit
}

function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, t)
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-3) {
      resolve()
      return
    }
    const done = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      resolve()
    }
    const fail = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      reject(new Error('video seek failed'))
    }
    video.addEventListener('seeked', done)
    video.addEventListener('error', fail)
    video.currentTime = target
  })
}

/** Draw the video frame into WxH preserving aspect ratio (letterbox/pillarbox). */
function drawContain(ctx: OffscreenCanvasRenderingContext2D, video: HTMLVideoElement, W: number, H: number): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return
  const scale = Math.min(W / vw, H / vh)
  const dw = vw * scale
  const dh = vh * scale
  ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

async function loadSourceVideos(events: EdlEvent[], sources: Source[]): Promise<Map<string, HTMLVideoElement>> {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const ids = [...new Set(events.map((e) => e.source_id))]
  const videos = new Map<string, HTMLVideoElement>()
  await Promise.all(
    ids.map(
      (id) =>
        new Promise<void>((resolve, reject) => {
          const src = byId.get(id)
          if (!src) {
            resolve()
            return
          }
          const video = document.createElement('video')
          video.muted = true
          video.preload = 'auto'
          video.src = getObjectUrl(src.id, src.file)
          video.addEventListener('loadedmetadata', () => {
            videos.set(id, video)
            resolve()
          }, { once: true })
          video.addEventListener('error', () => reject(new Error(`failed to load ${src.name}`)), { once: true })
        }),
    ),
  )
  return videos
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
  const videos = await loadSourceVideos(events, sources)
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
        const video = videos.get(ev.source_id)
        if (video) {
          await seekVideo(video, ev.source_in_s + (t - ev.timeline_in_s))
          drawContain(ctx, video, width, height)
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
    for (const v of videos.values()) {
      v.src = ''
      v.load()
    }
  }
}
