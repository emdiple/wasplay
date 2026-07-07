/**
 * Typed message protocol shared by the media worker and its main-thread client.
 *
 * Every operation reads bytes from a `File` (passed by-reference to the worker,
 * where `FileReaderSync` streams arbitrary ranges) so the main thread never
 * holds the full file in memory.
 */

import type { MediaInfo, SampleTable, ScanResult } from '../types'

/** Maps each worker op to its argument and result types. */
export interface WazOps {
  /** Probe container / codec info. */
  mediaInfo: { args: Record<string, never>; result: MediaInfo }
  /** Integrated loudness in LUFS. */
  lufs: { args: Record<string, never>; result: number }
  /**
   * Integrated loudness from pre-decoded interleaved f32 PCM — the fallback
   * for codecs symphonia can't decode (e.g. Opus), where the main thread
   * decodes via WebAudio and ships the samples here. `file` is unused.
   */
  lufsSamples: { args: { samples: Float32Array; sampleRate: number; channels: number }; result: number }
  /** Waveform peaks in [0,1]. */
  peaks: { args: { numPeaks: number }; result: Float32Array }
  /** Scan keyframes + pick `count` evenly-spaced indices. */
  scan: { args: { count: number }; result: { scan: ScanResult; selected: number[] } }
  /** Full video sample table for demux-based decode. */
  sampleTable: { args: Record<string, never>; result: SampleTable }
  /** Raw bytes of one encoded sample (any byte range). */
  keyframeBytes: { args: { offset: number; length: number }; result: Uint8Array }
}

export type WazOp = keyof WazOps

export interface WazRequest<Op extends WazOp = WazOp> {
  id: number
  op: Op
  file: File
  args: WazOps[Op]['args']
}

export type WazResponse<Op extends WazOp = WazOp> =
  | { id: number; ok: true; result: WazOps[Op]['result'] }
  | { id: number; ok: false; error: string }
