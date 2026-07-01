/**
 * fox-worker-client.js — main-thread RPC client for fox-worker.js.
 *
 * Spins up a single module worker on first use and exposes a small promise-based
 * API. Every call passes the `File` (cheap by-reference clone) so the worker can
 * stream bytes with FileReaderSync — the main thread never reads the file itself.
 */

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;

  worker = new Worker(new URL('./fox-worker.js', import.meta.url), { type: 'module' });

  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };

  // A fatal worker error (e.g. failed module import) rejects everything in flight.
  worker.onerror = (e) => {
    const msg = e.message || 'fox-worker crashed';
    for (const [, p] of pending) p.reject(new Error(msg));
    pending.clear();
    worker = null; // allow a fresh worker on the next call
  };

  return worker;
}

function call(op, file, args) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, file, args });
  });
}

export const fox = {
  /** Probe container/codec info. → parsed object */
  mediaInfo: (file) => call('mediaInfo', file, {}),
  /** Integrated loudness in LUFS. → number */
  lufs: (file) => call('lufs', file, {}),
  /** Waveform peaks in [0,1]. → Float32Array of length numPeaks */
  peaks: (file, numPeaks) => call('peaks', file, { numPeaks }),
  /** Scan keyframes + pick `count` evenly-spaced ones. → { scan, selected } */
  scan: (file, count) => call('scan', file, { count }),
  /** Raw bytes of one sample. → Uint8Array */
  keyframeBytes: (file, offset, length) => call('keyframeBytes', file, { offset, length }),
};
