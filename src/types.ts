/**
 * Shared domain types for Shadowfox Studio.
 *
 * The WASM-facing shapes (`MediaInfo`, `ScanResult`, …) mirror the JSON returned
 * by the Rust crates; see each crate's `src/lib.rs` (under `crates/`) for the
 * source of truth.
 */

// ── WASM results ──────────────────────────────────────────────────────────────

/** Container / codec probe from `fox-ear-wasm::get_media_info`. */
export interface MediaInfo {
  container: string
  audio_codec: string
  video_codec: string | null
  channels: number | null
  sample_rate: number | null
  bits_per_sample: number | null
}

/** One keyframe located by `fox-strip-wasm::scan_keyframes`. */
export interface KeyframeInfo {
  timestamp_s: number
  byte_offset: number
  byte_length: number
  index: number
}

/** Codec-init data for `VideoDecoder`, from the MP4 scan. */
export interface CodecConfig {
  codec: string
  description_b64: string
  width: number
  height: number
}

/** Full result of an MP4 keyframe scan. */
export interface ScanResult {
  config: CodecConfig
  keyframes: KeyframeInfo[]
  duration_s: number
}

/** One encoded video sample (frame) from `fox-strip-wasm::scan_samples`. */
export interface SampleInfo {
  /** Presentation timestamp (s) — stamp this on the EncodedVideoChunk. */
  pts_s: number
  /** Decode timestamp (s); samples are listed in this order. */
  dts_s: number
  byte_offset: number
  byte_length: number
  is_keyframe: boolean
}

/** Full video sample table — the demuxer output that feeds a `VideoDecoder`. */
export interface SampleTable {
  config: CodecConfig
  samples: SampleInfo[]
  duration_s: number
}

/** A decoded timeline thumbnail. */
export interface Thumbnail {
  bitmap: ImageBitmap
  timestamp_s: number
}

// ── Editor model ──────────────────────────────────────────────────────────────

/** HSL colour assigned to a source and shared by its linked A/V clips. */
export interface HSL {
  h: number
  s: number
  l: number
}

/** An imported media file plus its probed metadata and decoded decorations. */
export interface Source {
  id: string
  file: File
  name: string
  color: HSL
  isVideo: boolean
  hasAudio: boolean
  info: MediaInfo | null
  duration: number
  width: number
  height: number
  /** Video keyframe thumbnails (null until decoded / for audio sources). */
  thumbs: Thumbnail[] | null
  /** Waveform peaks in [0,1] (null until decoded / for silent sources). */
  peaks: Float32Array | null
  /**
   * Integrated loudness (EBU R128, LUFS), measured once at import.
   * `undefined` while measuring, `null` for silent/undecodable audio.
   */
  lufs: number | null | undefined
  /** User output gain in dB applied to this source's audio on export (0 = unity). */
  gainDb: number
}

/**
 * A clip placed on the timeline. A file's video and audio clips share a `link`
 * id so razor cuts keep the A/V pair in sync.
 */
export interface Clip {
  id: string
  sourceId: string
  link: string
  /** Timeline position of the clip's left edge, in seconds. */
  start: number
  /** In-point within the source, in seconds. */
  in: number
  /** Clip duration, in seconds. */
  dur: number
  /** Stacking order among overlapping clips on the same track (higher paints on top). */
  z: number
  /**
   * Per-clip output gain in dB applied to this clip's audio on export (0 = unity).
   * Seeded from the source's gain when placed; each clip (and split part) is then
   * independent. Only meaningful for audio clips.
   */
  gainDb: number
}

export type Tool = 'select' | 'cut'
export type TrackKind = 'video' | 'audio'
