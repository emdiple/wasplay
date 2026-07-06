/**
 * wazClient.ts — main-thread RPC client for the media worker pool.
 *
 * Spins up a small pool of module workers on first use (real OS-thread
 * parallelism — each worker is an independent WASM instance) and exposes a
 * small promise-based API. Every call passes the `File` (a cheap by-reference
 * clone) so a worker can stream bytes with `FileReaderSync` — the main thread
 * never reads the file itself.
 *
 * `wazWorker.ts` is fully stateless per call (no state carries between
 * requests), so any worker in the pool can serve any request — dispatch picks
 * whichever worker currently has the fewest requests in flight, since job
 * duration varies wildly (LUFS on a long file vs. a small keyframe fetch).
 */

import type { WazOp, WazOps, WazRequest, WazResponse } from './protocol'

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  workerIndex: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Each pool worker lazily instantiates its own WASM modules (own linear
// memory), so growing the pool isn't free — cap it well below most machines'
// core count. Floor of 2 guarantees real parallelism even where
// hardwareConcurrency under-reports.
const POOL_SIZE = clamp(navigator.hardwareConcurrency || 4, 2, 6)

const workers: (Worker | null)[] = new Array(POOL_SIZE).fill(null)
const inFlight: number[] = new Array(POOL_SIZE).fill(0)
let seq = 0
const pending = new Map<number, Pending>()

function makeWorker(index: number): Worker {
  const w = new Worker(new URL('./wazWorker.ts', import.meta.url), { type: 'module' })

  w.onmessage = (e: MessageEvent<WazResponse>) => {
    const msg = e.data
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    inFlight[p.workerIndex] = Math.max(0, inFlight[p.workerIndex] - 1)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  }

  // A fatal worker error (e.g. failed module import) rejects only this
  // worker's in-flight requests; the slot is recreated on next dispatch.
  w.onerror = (e) => {
    const message = e.message || 'waz-worker crashed'
    for (const [id, p] of pending) {
      if (p.workerIndex !== index) continue
      pending.delete(id)
      p.reject(new Error(message))
    }
    inFlight[index] = 0
    workers[index] = null
  }

  return w
}

/** Index of the worker with the fewest requests in flight (creating any unstarted slots as needed). */
function pickWorker(): number {
  let best = 0
  for (let i = 1; i < POOL_SIZE; i++) {
    if (inFlight[i] < inFlight[best]) best = i
  }
  if (!workers[best]) workers[best] = makeWorker(best)
  return best
}

function call<Op extends WazOp>(
  op: Op,
  file: File,
  args: WazOps[Op]['args'],
  transfer: Transferable[] = [],
): Promise<WazOps[Op]['result']> {
  const workerIndex = pickWorker()
  const w = workers[workerIndex]!
  const id = ++seq
  inFlight[workerIndex]++
  return new Promise<WazOps[Op]['result']>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, workerIndex })
    const request: WazRequest<Op> = { id, op, file, args }
    w.postMessage(request, transfer)
  })
}

export const waz = {
  /** Probe container / codec info. */
  mediaInfo: (file: File) => call('mediaInfo', file, {}),
  /** Integrated loudness in LUFS. */
  lufs: (file: File) => call('lufs', file, {}),
  /**
   * Integrated loudness from pre-decoded interleaved f32 PCM (WebAudio
   * fallback for codecs symphonia lacks, e.g. Opus). Transfers `samples`.
   */
  lufsSamples: (file: File, samples: Float32Array, sampleRate: number, channels: number) =>
    call('lufsSamples', file, { samples, sampleRate, channels }, [samples.buffer]),
  /** Waveform peaks in [0,1] — a Float32Array of length `numPeaks`. */
  peaks: (file: File, numPeaks: number) => call('peaks', file, { numPeaks }),
  /** Scan keyframes + pick `count` evenly-spaced ones. */
  scan: (file: File, count: number) => call('scan', file, { count }),
  /** Full video sample table (every frame) for demux-based decode. */
  sampleTable: (file: File) => call('sampleTable', file, {}),
  /** Raw bytes of one encoded sample (any byte range). */
  keyframeBytes: (file: File, offset: number, length: number) => call('keyframeBytes', file, { offset, length }),
}
