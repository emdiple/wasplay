/**
 * codecs.ts — pick the best WebCodecs encoder configuration the current browser
 * actually supports. For MP4 the ladder is AV1 → HEVC → H.264 High → H.264
 * Baseline; AV1/HEVC are taken only when the machine encodes them in *hardware*
 * (fast, and the efficiency win is free) — otherwise H.264 wins as the most
 * universally playable output. Falls back to WebM/AV1(hw) → VP9 → VP8 + Opus
 * (which every WebCodecs-capable browser can encode, so export always works).
 */

export interface ExportCodecPlan {
  container: 'mp4' | 'webm'
  ext: string
  mime: string
  video: {
    /** WebCodecs codec string, e.g. 'avc1.640028' or 'av01.0.08M.08'. */
    codec: string
    /** Codec id the chosen muxer expects. */
    muxerCodec: 'avc' | 'hevc' | 'av1' | 'vp9' | 'vp8'
    bitrate: number
    /** True when this codec was chosen on the condition of a hardware encoder. */
    hardware: boolean
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

interface VideoCandidate {
  codec: string
  container: 'mp4' | 'webm'
  muxerCodec: ExportCodecPlan['video']['muxerCodec']
  /** Only accept this codec when the encoder is hardware-backed. */
  hardwareOnly?: boolean
}

/**
 * Codec ladder for the given output size. Codec strings carry a level, which is
 * a declared ceiling on resolution/rate — pick a higher level for >1080p so the
 * config isn't rejected outright.
 */
function videoCandidates(width: number, height: number): VideoCandidate[] {
  const big = width * height > 1920 * 1088 // above 1080p
  return [
    // MP4 — modern codecs only when hardware-encoded; H.264 as the universal default.
    { codec: big ? 'av01.0.12M.08' : 'av01.0.08M.08', container: 'mp4', muxerCodec: 'av1', hardwareOnly: true },
    { codec: big ? 'hvc1.1.6.L153.B0' : 'hvc1.1.6.L120.B0', container: 'mp4', muxerCodec: 'hevc', hardwareOnly: true },
    { codec: big ? 'avc1.640033' : 'avc1.640028', container: 'mp4', muxerCodec: 'avc' }, // H.264 High
    { codec: 'avc1.42001f', container: 'mp4', muxerCodec: 'avc' }, // H.264 Baseline
    // WebM fallback for browsers with no MP4-family encoder.
    { codec: big ? 'av01.0.12M.08' : 'av01.0.08M.08', container: 'webm', muxerCodec: 'av1', hardwareOnly: true },
    { codec: 'vp09.00.10.08', container: 'webm', muxerCodec: 'vp9' },
    { codec: 'vp8', container: 'webm', muxerCodec: 'vp8' },
  ]
}

async function videoSupported(
  codec: string,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  hardwareOnly = false,
) {
  try {
    const config: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate }
    // Per spec, 'prefer-hardware' reports supported only when a hardware encoder
    // is actually available — exactly the gate we want for AV1/HEVC.
    if (hardwareOnly) config.hardwareAcceleration = 'prefer-hardware'
    const support = await VideoEncoder.isConfigSupported(config)
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

  let chosen: VideoCandidate | null = null
  for (const cand of videoCandidates(w, h)) {
    if (await videoSupported(cand.codec, w, h, fps, vBitrate, cand.hardwareOnly)) {
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
    video: { codec: chosen.codec, muxerCodec: chosen.muxerCodec, bitrate: vBitrate, hardware: !!chosen.hardwareOnly },
    audio,
  }
}
