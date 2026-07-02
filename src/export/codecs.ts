/**
 * codecs.ts — pick the best WebCodecs encoder configuration the current browser
 * actually supports. Prefers MP4/H.264+AAC; falls back to WebM/VP9(or VP8)+Opus
 * (which every WebCodecs-capable browser can encode, so export always works).
 */

export interface ExportCodecPlan {
  container: 'mp4' | 'webm'
  ext: string
  mime: string
  video: {
    /** WebCodecs codec string, e.g. 'avc1.42001f' or 'vp09.00.10.08'. */
    codec: string
    /** Codec id the chosen muxer expects. */
    muxerCodec: 'avc' | 'vp9' | 'vp8'
    bitrate: number
  }
  audio: {
    codec: string
    muxerCodec: 'aac' | 'opus'
    bitrate: number
  } | null
}

/** Round down to the nearest even number (H.264 requires even dimensions). */
export const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

function videoBitrate(width: number, height: number, fps: number): number {
  return Math.min(20_000_000, Math.max(2_000_000, Math.round(width * height * fps * 0.15)))
}

const VIDEO_CANDIDATES: { codec: string; container: 'mp4' | 'webm'; muxerCodec: 'avc' | 'vp9' | 'vp8' }[] = [
  { codec: 'avc1.42001f', container: 'mp4', muxerCodec: 'avc' }, // H.264 baseline
  { codec: 'vp09.00.10.08', container: 'webm', muxerCodec: 'vp9' },
  { codec: 'vp8', container: 'webm', muxerCodec: 'vp8' },
]

async function videoSupported(codec: string, width: number, height: number, fps: number, bitrate: number) {
  try {
    const support = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate })
    return !!support.supported
  } catch {
    return false
  }
}

async function audioSupported(codec: string, sampleRate: number, channels: number, bitrate: number) {
  try {
    const support = await AudioEncoder.isConfigSupported({ codec, sampleRate, numberOfChannels: channels, bitrate })
    return !!support.supported
  } catch {
    return false
  }
}

/**
 * Resolve a working codec plan for the given output. Throws if the browser
 * supports no video encoder at all (no WebCodecs encode).
 */
export async function pickCodecs(
  width: number,
  height: number,
  fps: number,
  needAudio: boolean,
  sampleRate = 48000,
  channels = 2,
): Promise<ExportCodecPlan> {
  const w = even(width)
  const h = even(height)
  const vBitrate = videoBitrate(w, h, fps)

  let chosen: (typeof VIDEO_CANDIDATES)[number] | null = null
  for (const cand of VIDEO_CANDIDATES) {
    if (await videoSupported(cand.codec, w, h, fps, vBitrate)) {
      chosen = cand
      break
    }
  }
  if (!chosen) throw new Error('This browser has no supported WebCodecs video encoder (try Chrome/Edge).')

  const container = chosen.container
  let audio: ExportCodecPlan['audio'] = null
  if (needAudio) {
    const aBitrate = 128_000
    if (container === 'mp4' && (await audioSupported('mp4a.40.2', sampleRate, channels, aBitrate))) {
      audio = { codec: 'mp4a.40.2', muxerCodec: 'aac', bitrate: aBitrate }
    } else if (await audioSupported('opus', sampleRate, channels, aBitrate)) {
      audio = { codec: 'opus', muxerCodec: 'opus', bitrate: aBitrate }
    }
    // If neither AAC nor Opus is available, export silent video rather than fail.
  }

  return {
    container,
    ext: container === 'mp4' ? 'mp4' : 'webm',
    mime: container === 'mp4' ? 'video/mp4' : 'video/webm',
    video: { codec: chosen.codec, muxerCodec: chosen.muxerCodec, bitrate: vBitrate },
    audio,
  }
}
