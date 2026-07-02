/**
 * Typed message protocol shared by the media worker and its main-thread client.
 *
 * Every operation reads bytes from a `File` (passed by-reference to the worker,
 * where `FileReaderSync` streams arbitrary ranges) so the main thread never
 * holds the full file in memory.
 */

import type { MediaInfo, ScanResult } from '../types'

/** Maps each worker op to its argument and result types. */
export interface FoxOps {
  /** Probe container / codec info. */
  mediaInfo: { args: Record<string, never>; result: MediaInfo }
  /** Integrated loudness in LUFS. */
  lufs: { args: Record<string, never>; result: number }
  /** Waveform peaks in [0,1]. */
  peaks: { args: { numPeaks: number }; result: Float32Array }
  /** Scan keyframes + pick `count` evenly-spaced indices. */
  scan: { args: { count: number }; result: { scan: ScanResult; selected: number[] } }
  /** Raw bytes of one encoded sample. */
  keyframeBytes: { args: { offset: number; length: number }; result: Uint8Array }
}

export type FoxOp = keyof FoxOps

export interface FoxRequest<Op extends FoxOp = FoxOp> {
  id: number
  op: Op
  file: File
  args: FoxOps[Op]['args']
}

export type FoxResponse<Op extends FoxOp = FoxOp> =
  | { id: number; ok: true; result: FoxOps[Op]['result'] }
  | { id: number; ok: false; error: string }
