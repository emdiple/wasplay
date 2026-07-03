/**
 * foxWorker.ts — WASM media worker (module worker).
 *
 * Runs every WASM module that needs to read an entire media file. Instead of
 * receiving a giant ArrayBuffer from the main thread, it receives the `File`
 * handle (a cheap by-reference structured clone) and reads byte ranges on demand
 * with `FileReaderSync`. The WASM streaming entry points pull only the bytes they
 * need — audio is decoded packet-by-packet, and the MP4 scanner reads just the
 * `moov` box — so multi-gigabyte files never have to live in memory anywhere.
 */

/// <reference lib="webworker" />

import initEar, { get_media_info_streaming, measure_lufs_streaming } from './pkg/fox-ear-wasm/fox_ear_wasm.js'
import initWave, { extract_peaks_streaming } from './pkg/fox-soundwave-wasm/fox_soundwave_wasm.js'
import initStrip, {
  scan_keyframes_streaming,
  scan_samples_streaming,
  get_keyframe_bytes_streaming,
  select_thumbnail_keyframes,
} from './pkg/fox-strip-wasm/fox_strip_wasm.js'

import type { FoxRequest, FoxResponse } from './protocol'

// Lazily initialise each module the first time it's needed; cache the promise.
const inits: Record<'ear' | 'wave' | 'strip', Promise<unknown> | null> = {
  ear: null,
  wave: null,
  strip: null,
}
const initFns = { ear: initEar, wave: initWave, strip: initStrip }
const ensure = (mod: keyof typeof inits) => (inits[mod] ??= initFns[mod]())

/** A synchronous `(offset, len) => Uint8Array` reader over a File. */
type Reader = (offset: number, len: number) => Uint8Array

/**
 * Build a synchronous reader over a File. `FileReaderSync` is only available
 * inside workers — this is what makes lazy random-access reads possible without
 * blocking the main thread.
 */
function makeReader(file: File): Reader {
  const frs = new FileReaderSync()
  return (offset, len) => {
    const start = Math.min(offset, file.size)
    const end = Math.min(offset + len, file.size)
    const buf = frs.readAsArrayBuffer(file.slice(start, end))
    return new Uint8Array(buf)
  }
}

self.onmessage = async (e: MessageEvent<FoxRequest>) => {
  const { id, op, file, args } = e.data
  try {
    const read = makeReader(file)
    let result: unknown
    let transfer: Transferable[] = []

    switch (op) {
      case 'mediaInfo': {
        await ensure('ear')
        result = JSON.parse(get_media_info_streaming(read, file.size))
        break
      }
      case 'lufs': {
        await ensure('ear')
        result = measure_lufs_streaming(read, file.size)
        break
      }
      case 'peaks': {
        await ensure('wave')
        const peaks = extract_peaks_streaming(read, file.size, (args as { numPeaks: number }).numPeaks)
        result = peaks // Float32Array
        transfer = [peaks.buffer] // hand ownership to main thread, no copy
        break
      }
      case 'scan': {
        await ensure('strip')
        const scanJson = scan_keyframes_streaming(read, file.size)
        const selected = JSON.parse(select_thumbnail_keyframes(scanJson, (args as { count: number }).count))
        result = { scan: JSON.parse(scanJson), selected }
        break
      }
      case 'sampleTable': {
        await ensure('strip')
        result = JSON.parse(scan_samples_streaming(read, file.size))
        break
      }
      case 'keyframeBytes': {
        await ensure('strip')
        const { offset, length } = args as { offset: number; length: number }
        const bytes = get_keyframe_bytes_streaming(read, offset, length)
        result = bytes // Uint8Array
        transfer = [bytes.buffer]
        break
      }
      default:
        throw new Error(`unknown op: ${op as string}`)
    }

    const response = { id, ok: true, result } as FoxResponse
    self.postMessage(response, transfer)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const response: FoxResponse = { id, ok: false, error: message }
    self.postMessage(response)
  }
}
