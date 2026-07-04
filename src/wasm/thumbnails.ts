/**
 * thumbnails.ts — timeline thumbnail generator.
 *
 * The MP4 keyframe scan runs in the worker, which reads only the `moov` box from
 * the File via FileReaderSync — the full video is never loaded into memory.
 *
 * Fast path (Chrome/Edge): worker returns keyframe byte offsets → main thread
 *   fetches each keyframe's bytes from the worker → WebCodecs hardware-decodes →
 *   OffscreenCanvas → ImageBitmap.
 *
 * Fallback (Safari / Firefox): a hidden <video> element seeks to each keyframe
 *   timestamp → canvas capture → ImageBitmap. Slower but works in any browser
 *   that can play the file, and still avoids reading the whole file into a buffer.
 */

import { waz } from './wazClient'
import type { CodecConfig, KeyframeInfo, ScanResult, Thumbnail } from '../types'

export interface ThumbnailOptions {
  /** Number of thumbnails (default 10). */
  count?: number
  /** Thumb width in px (default 160). */
  width?: number
  /** Thumb height in px (default 90). */
  height?: number
}

/** Generate timeline thumbnails from a video file. */
export async function generateThumbnails(
  file: File,
  { count = 10, width = 160, height = 90 }: ThumbnailOptions = {},
): Promise<Thumbnail[]> {
  // 1. Scan container in the worker (reads only the moov box) + pick indices.
  const { scan, selected } = await waz.scan(file, count)

  if (!scan.keyframes.length) {
    throw new Error('No keyframes found — is this a valid MP4 with video?')
  }

  const selectedKfs = selected.map((i) => scan.keyframes[i])

  // 2a. WebCodecs fast path (Chrome 94+, Edge 94+)
  if ('VideoDecoder' in globalThis) {
    return decodeViaWebCodecs(file, scan, selectedKfs, width, height)
  }

  // 2b. Fallback: seek a hidden <video> element (Safari, Firefox, …)
  return decodeViaVideoSeek(file, selectedKfs, width, height)
}

// ── WebCodecs path ────────────────────────────────────────────────────────────

async function decodeViaWebCodecs(
  file: File,
  scan: ScanResult,
  keyframes: KeyframeInfo[],
  thumbW: number,
  thumbH: number,
): Promise<Thumbnail[]> {
  const config: CodecConfig = scan.config

  const decoderConfig: VideoDecoderConfig = {
    codec: config.codec,
    codedWidth: config.width || thumbW,
    codedHeight: config.height || thumbH,
  }
  if (config.description_b64) {
    decoderConfig.description = base64ToBuffer(config.description_b64)
  }

  let support: VideoDecoderSupport
  try {
    support = await VideoDecoder.isConfigSupported(decoderConfig)
  } catch {
    support = { supported: false }
  }
  if (!support.supported) {
    // Codec not decodable by WebCodecs here (e.g. HEVC on some platforms).
    return decodeViaVideoSeek(file, keyframes, thumbW, thumbH)
  }

  const results: Thumbnail[] = []
  for (const kf of keyframes) {
    // Fetch just this keyframe's bytes from the worker (small range read).
    const data = await waz.keyframeBytes(file, kf.byte_offset, kf.byte_length)
    const bitmap = await decodeOneFrame(data, kf, decoderConfig, thumbW, thumbH)
    results.push({ bitmap, timestamp_s: kf.timestamp_s })
  }
  return results
}

function decodeOneFrame(
  data: Uint8Array,
  kf: KeyframeInfo,
  decoderConfig: VideoDecoderConfig,
  thumbW: number,
  thumbH: number,
): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    let settled = false

    const decoder = new VideoDecoder({
      output(videoFrame) {
        if (settled) {
          videoFrame.close()
          return
        }
        settled = true
        try {
          const canvas = new OffscreenCanvas(thumbW, thumbH)
          canvas.getContext('2d')!.drawImage(videoFrame, 0, 0, thumbW, thumbH)
          videoFrame.close()
          resolve(canvas.transferToImageBitmap())
        } catch (e) {
          videoFrame.close()
          reject(e as Error)
        }
      },
      error(e) {
        if (!settled) {
          settled = true
          reject(e)
        }
      },
    })

    decoder.configure(decoderConfig)
    decoder.decode(
      new EncodedVideoChunk({
        type: 'key',
        timestamp: Math.max(0, Math.round(kf.timestamp_s * 1_000_000)),
        data,
      }),
    )
    decoder.flush().catch((e) => {
      if (!settled) {
        settled = true
        reject(e as Error)
      }
    })
  })
}

// ── Video-seek fallback ───────────────────────────────────────────────────────

async function decodeViaVideoSeek(
  file: File,
  keyframes: KeyframeInfo[],
  thumbW: number,
  thumbH: number,
): Promise<Thumbnail[]> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = url

  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new Error('Video load error')), { once: true })
  })

  const results: Thumbnail[] = []
  for (const kf of keyframes) {
    const bitmap = await seekAndCapture(video, kf.timestamp_s, thumbW, thumbH)
    results.push({ bitmap, timestamp_s: kf.timestamp_s })
  }

  URL.revokeObjectURL(url)
  video.src = ''
  return results
}

function seekAndCapture(video: HTMLVideoElement, time: number, width: number, height: number): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d')!.drawImage(video, 0, 0, width, height)
        createImageBitmap(canvas).then(resolve, reject)
      } catch (e) {
        reject(e as Error)
      }
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', () => reject(new Error('Video seek error')), { once: true })
    video.currentTime = time
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64ToBuffer(b64: string): Uint8Array {
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf
}
