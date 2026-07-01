/**
 * fox-worker.js — WASM media worker (module worker).
 *
 * Runs every WASM module that needs to read an entire media file. Instead of
 * receiving a giant ArrayBuffer from the main thread, it receives the `File`
 * handle (a cheap by-reference structured clone) and reads byte ranges on demand
 * with `FileReaderSync`. The WASM streaming entry points pull only the bytes they
 * need — audio is decoded packet-by-packet, and the MP4 scanner reads just the
 * `moov` box — so multi-gigabyte files never have to live in memory anywhere.
 *
 * This is the WorkerFS-style bridge: `FileReaderSync` gives synchronous random
 * access to the File, and the Rust `JsReader` calls back into it per read.
 */

import initEar, { get_media_info_streaming, measure_lufs_streaming }
  from './fox-ear-wasm/pkg/fox_ear_wasm.js';
import initWave, { extract_peaks_streaming }
  from './fox-soundwave-wasm/pkg/fox_soundwave_wasm.js';
import initStrip, { scan_keyframes_streaming, get_keyframe_bytes_streaming, select_thumbnail_keyframes }
  from './fox-strip-wasm/pkg/fox_strip_wasm.js';

// Lazily initialise each module the first time it's needed; cache the promise.
const inits = { ear: null, wave: null, strip: null };
const ensure = (mod) => (inits[mod] ??= {
  ear:   initEar,
  wave:  initWave,
  strip: initStrip,
}[mod]());

/**
 * Build a synchronous `(offset, len) => Uint8Array` reader over a File.
 * `FileReaderSync` is only available inside workers — this is what makes the
 * lazy random-access reads possible without blocking the main thread.
 */
function makeReader(file) {
  const frs = new FileReaderSync();
  return (offset, len) => {
    const start = Math.min(offset, file.size);
    const end   = Math.min(offset + len, file.size);
    const buf   = frs.readAsArrayBuffer(file.slice(start, end));
    return new Uint8Array(buf);
  };
}

self.onmessage = async (e) => {
  const { id, op, file, args = {} } = e.data;
  try {
    const read = file ? makeReader(file) : null;
    let result;
    let transfer = [];

    switch (op) {
      case 'mediaInfo': {
        await ensure('ear');
        result = JSON.parse(get_media_info_streaming(read, file.size));
        break;
      }
      case 'lufs': {
        await ensure('ear');
        result = measure_lufs_streaming(read, file.size);
        break;
      }
      case 'peaks': {
        await ensure('wave');
        const peaks = extract_peaks_streaming(read, file.size, args.numPeaks);
        result = peaks;                // Float32Array
        transfer = [peaks.buffer];     // hand ownership to main thread, no copy
        break;
      }
      case 'scan': {
        await ensure('strip');
        const scanJson = scan_keyframes_streaming(read, file.size);
        const selected = JSON.parse(select_thumbnail_keyframes(scanJson, args.count));
        result = { scan: JSON.parse(scanJson), selected };
        break;
      }
      case 'keyframeBytes': {
        await ensure('strip');
        const bytes = get_keyframe_bytes_streaming(read, args.offset, args.length);
        result = bytes;                // Uint8Array
        transfer = [bytes.buffer];
        break;
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }

    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
