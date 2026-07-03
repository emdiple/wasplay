/**
 * frameSource.ts — per-source frame providers for the export renderer.
 *
 * Two implementations behind one interface:
 *
 *  - DecoderFrameSource (fast): demux the MP4 via fox-strip's sample table and
 *    decode sequentially with a WebCodecs VideoDecoder — no per-frame <video>
 *    seeking. Reads each GOP's bytes in one streamed range read, decodes forward,
 *    and hands back the frame whose PTS covers the requested time. Resets to the
 *    prior keyframe only on a backward jump (rare in cut/arrange edits).
 *
 *  - SeekFrameSource (fallback): the original approach — seek a hidden <video>
 *    to each timestamp. Handles anything the browser can play (non-MP4, or codecs
 *    WebCodecs can't decode).
 *
 * `createFrameSource` picks the fast path only when a smoke-test decode of the
 * first keyframe actually produces a frame in this browser; otherwise it falls
 * back. So a browser without H.264 WebCodecs decode, or an exotic source, still
 * exports correctly.
 */

import { fox } from '../wasm/foxClient'
import { getObjectUrl } from '../lib/objectUrlCache'
import type { SampleInfo, Source } from '../types'

/** A drawable frame positioned at a source-local time, plus its pixel size. */
export interface FrameSource {
  /** Returns a drawable (VideoFrame / <video>) showing the frame at `localT`. */
  getFrame(localT: number): Promise<CanvasImageSource | null>
  /** Intrinsic dimensions of the current drawable (0 until known). */
  dims(): [number, number]
  close(): void
}

const MP4_RX = /\.(mp4|m4v|mov)$/i

// ── Fast path: demux + VideoDecoder ───────────────────────────────────────────

interface QueuedFrame {
  frame: VideoFrame
  pts: number
}

class DecoderFrameSource implements FrameSource {
  private decoder!: VideoDecoder
  private queue: QueuedFrame[] = []
  private fedIndex = 0 // next sample index to feed
  private held: VideoFrame | null = null // last frame returned (closed on next call)
  private error: unknown = null
  private wake: (() => void) | null = null

  private constructor(
    private file: File,
    private samples: SampleInfo[],
    private config: VideoDecoderConfig,
  ) {
    this.initDecoder()
  }

  private initDecoder() {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.queue.push({ frame, pts: frame.timestamp / 1_000_000 })
        this.wake?.()
      },
      error: (e) => {
        this.error = e
        this.wake?.()
      },
    })
    this.decoder.configure(this.config)
  }

  /** Index of the last keyframe whose PTS is at or before `t`. */
  private keyframeIndexFor(t: number): number {
    let idx = 0
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].is_keyframe && this.samples[i].pts_s <= t + 1e-6) idx = i
    }
    return idx
  }

  /** Feed one GOP (keyframe → up to the next keyframe) as a single range read. */
  private async feedGop(startIdx: number): Promise<void> {
    let end = startIdx + 1
    while (end < this.samples.length && !this.samples[end].is_keyframe) end++
    const first = this.samples[startIdx]
    const last = this.samples[end - 1]
    const spanStart = first.byte_offset
    const spanLen = last.byte_offset + last.byte_length - spanStart
    const bytes = await fox.keyframeBytes(this.file, spanStart, spanLen)
    for (let i = startIdx; i < end; i++) {
      const s = this.samples[i]
      const off = s.byte_offset - spanStart
      this.decoder.decode(
        new EncodedVideoChunk({
          type: s.is_keyframe ? 'key' : 'delta',
          timestamp: Math.round(s.pts_s * 1_000_000),
          data: bytes.subarray(off, off + s.byte_length),
        }),
      )
    }
    this.fedIndex = end
  }

  private async reseek(localT: number): Promise<void> {
    for (const q of this.queue) q.frame.close()
    this.queue = []
    this.decoder.reset()
    this.decoder.configure(this.config)
    this.fedIndex = this.keyframeIndexFor(localT)
  }

  /** Wait until the decoder emits at least one more frame (or errors). */
  private waitForOutput(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null
        resolve()
      }
    })
  }

  async getFrame(localT: number): Promise<CanvasImageSource | null> {
    if (this.error) throw this.error

    // Backward jump (or nothing decoded yet before this time): reset to keyframe.
    const earliest = this.queue.length ? this.queue[0].pts : Infinity
    if (localT < earliest - 1e-3 && this.fedIndex > this.keyframeIndexFor(localT) + 1) {
      await this.reseek(localT)
    }
    if (this.fedIndex === 0 && this.queue.length === 0) {
      this.fedIndex = this.keyframeIndexFor(localT)
    }

    // Feed forward until a frame at/after localT is available (or samples run out).
    while (!this.queue.some((q) => q.pts >= localT - 1e-6) && this.fedIndex < this.samples.length) {
      const startIdx = this.fedIndex
      await this.feedGop(startIdx)
      // Give the decoder time to emit; flush if we've reached the end.
      if (this.fedIndex >= this.samples.length) await this.decoder.flush().catch(() => {})
      else if (!this.queue.length) await Promise.race([this.waitForOutput(), delay(50)])
      if (this.error) throw this.error
    }
    // Drain any straggler outputs already produced.
    if (!this.queue.length) await Promise.race([this.waitForOutput(), delay(20)])

    // Pick the frame with the greatest pts <= localT (the one on screen now);
    // fall back to the earliest available if none yet reached localT.
    let picked: QueuedFrame | null = null
    for (const q of this.queue) {
      if (q.pts <= localT + 1e-6 && (!picked || q.pts > picked.pts)) picked = q
    }
    if (!picked && this.queue.length) picked = this.queue[0]
    if (!picked) return null

    // Release frames strictly older than the picked one (never needed again
    // while time only moves forward), and the previously-held frame.
    this.queue = this.queue.filter((q) => {
      if (q !== picked && q.pts < picked!.pts) {
        q.frame.close()
        return false
      }
      return true
    })
    if (this.held && this.held !== picked.frame) this.held.close()
    this.held = picked.frame
    return picked.frame
  }

  dims(): [number, number] {
    if (this.held) return [this.held.displayWidth, this.held.displayHeight]
    return [this.config.codedWidth ?? 0, this.config.codedHeight ?? 0]
  }

  close(): void {
    for (const q of this.queue) q.frame.close()
    this.queue = []
    this.held = null
    try {
      this.decoder.close()
    } catch {
      /* already closed */
    }
  }

  /** Build a fast source, smoke-testing that the first keyframe actually decodes. */
  static async create(source: Source): Promise<DecoderFrameSource | null> {
    if (!('VideoDecoder' in globalThis)) return null
    if (!(source.file.type === 'video/mp4' || MP4_RX.test(source.name))) return null
    try {
      const table = await fox.sampleTable(source.file)
      if (!table.samples.length) return null
      const config: VideoDecoderConfig = {
        codec: table.config.codec,
        codedWidth: table.config.width || undefined,
        codedHeight: table.config.height || undefined,
      }
      if (table.config.description_b64) config.description = base64ToBuffer(table.config.description_b64)
      const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))
      if (!support.supported) return null

      const src = new DecoderFrameSource(source.file, table.samples, config)
      // Smoke test: the first frame must actually come out in this browser.
      const first = await src.getFrame(table.samples[0].pts_s).catch(() => null)
      if (!first) {
        src.close()
        return null
      }
      return src
    } catch {
      return null
    }
  }
}

// ── Fallback: <video> seek ─────────────────────────────────────────────────────

class SeekFrameSource implements FrameSource {
  private constructor(private video: HTMLVideoElement) {}

  async getFrame(localT: number): Promise<CanvasImageSource | null> {
    const target = Math.max(0, localT)
    const v = this.video
    if (!(v.readyState >= 2 && Math.abs(v.currentTime - target) < 1e-3)) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          v.removeEventListener('seeked', done)
          v.removeEventListener('error', fail)
          resolve()
        }
        const fail = () => {
          v.removeEventListener('seeked', done)
          v.removeEventListener('error', fail)
          reject(new Error('seek failed'))
        }
        v.addEventListener('seeked', done)
        v.addEventListener('error', fail)
        v.currentTime = target
      })
    }
    return v
  }

  dims(): [number, number] {
    return [this.video.videoWidth, this.video.videoHeight]
  }

  close(): void {
    this.video.src = ''
    this.video.load()
  }

  static create(source: Source): Promise<SeekFrameSource> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      video.muted = true
      video.preload = 'auto'
      video.src = getObjectUrl(source.id, source.file)
      video.addEventListener('loadedmetadata', () => resolve(new SeekFrameSource(video)), { once: true })
      video.addEventListener('error', () => reject(new Error(`failed to load ${source.name}`)), { once: true })
    })
  }
}

/** Fast demux+decode source when possible, else the <video>-seek fallback. */
export async function createFrameSource(source: Source): Promise<FrameSource> {
  const fast = await DecoderFrameSource.create(source)
  if (fast) return fast
  return SeekFrameSource.create(source)
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function base64ToBuffer(b64: string): Uint8Array {
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf
}
