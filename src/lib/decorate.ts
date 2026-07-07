/**
 * decorate.ts — derive a source's decoded decorations from its file bytes.
 *
 * Waveform peaks, keyframe thumbnails and integrated loudness are all recomputed
 * from the `File`, never persisted — so both the importer and the session-restore
 * path share this. Each result is written back to the store as it lands.
 */

import { waz } from '../wasm/wazClient'
import { generateThumbnails } from '../wasm/thumbnails'
import { useEditorStore } from '../store/editorStore'
import type { Source } from '../types'

// ── WebAudio fallback ─────────────────────────────────────────────────────────
// Symphonia (in the worker) covers MP4/MOV/MKV/WebM/OGG/WAV/AIFF/CAF containers
// and AAC/ALAC/FLAC/MP3/Vorbis/PCM/… codecs — but has no Opus decoder, the most
// common WebM audio. For those files, decode once on the main thread with
// WebAudio (anything the browser can play) and derive peaks + LUFS from the PCM.

/** Whole-file decode expands to raw PCM in memory — don't attempt it on huge files. */
const FALLBACK_MAX_BYTES = 512 * 1024 * 1024

/** One decode per File, shared by the peaks and LUFS fallbacks. */
const decodedCache = new WeakMap<File, Promise<AudioBuffer>>()

function decodeWithWebAudio(file: File): Promise<AudioBuffer> {
  let p = decodedCache.get(file)
  if (!p) {
    p = (async () => {
      if (file.size > FALLBACK_MAX_BYTES) throw new Error('file too large for WebAudio fallback')
      const bytes = await file.arrayBuffer()
      // Offline context: no audible output restrictions; 48 kHz matches export.
      return new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes)
    })()
    decodedCache.set(file, p)
  }
  return p
}

/** Max-abs peak per bucket across channels, in [0,1] — mirrors extract_peaks. */
function peaksFromBuffer(buf: AudioBuffer, numPeaks: number): Float32Array {
  const out = new Float32Array(numPeaks)
  const perBucket = buf.length / numPeaks
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c)
    for (let i = 0; i < numPeaks; i++) {
      const start = Math.floor(i * perBucket)
      const end = Math.min(buf.length, Math.ceil((i + 1) * perBucket))
      let max = 0
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j])
        if (v > max) max = v
      }
      if (max > out[i]) out[i] = Math.min(1, max)
    }
  }
  return out
}

/** Interleave up to two channels for measure_lufs (mono/stereo covers WebAudio output). */
function interleaveForLufs(buf: AudioBuffer): { samples: Float32Array; channels: number } {
  const channels = Math.min(2, buf.numberOfChannels)
  if (channels === 1) return { samples: buf.getChannelData(0).slice(), channels }
  const l = buf.getChannelData(0)
  const r = buf.getChannelData(1)
  const samples = new Float32Array(buf.length * 2)
  for (let i = 0; i < buf.length; i++) {
    samples[i * 2] = l[i]
    samples[i * 2 + 1] = r[i]
  }
  return { samples, channels }
}

/**
 * Decode the waveform peaks + keyframe thumbnails for a source, writing them
 * back to the store as each completes. Resolves when both are ready, so the
 * importer can hold the app until decoding finishes (restore doesn't await).
 */
export async function decorateSource(src: Source): Promise<void> {
  const { updateSource } = useEditorStore.getState()
  const jobs: Promise<void>[] = []
  if (src.hasAudio) {
    jobs.push(
      waz
        .peaks(src.file, 1200)
        .catch(() => decodeWithWebAudio(src.file).then((buf) => peaksFromBuffer(buf, 1200)))
        .then((peaks) => updateSource(src.id, { peaks }))
        .catch(() => {}),
    )
  }
  if (src.isVideo) {
    jobs.push(
      generateThumbnails(src.file, { count: 16, width: 160, height: 90 })
        .then((thumbs) => updateSource(src.id, { thumbs }))
        .catch(() => {}),
    )
  }
  await Promise.all(jobs)
}

/**
 * Measure integrated loudness (EBU R128) in the background and write it back.
 * It's a second full decode pass, so it never blocks — the bin shows "measuring…"
 * until it lands. Silent sources are left `null`.
 */
export function measureLoudness(src: Source): void {
  if (!src.hasAudio) return
  const { updateSource } = useEditorStore.getState()
  waz
    .lufs(src.file)
    .catch(() =>
      // Symphonia couldn't decode (e.g. Opus) — decode via WebAudio and run
      // the same EBU R128 measurement on the raw PCM in the worker.
      decodeWithWebAudio(src.file).then((buf) => {
        const { samples, channels } = interleaveForLufs(buf)
        return waz.lufsSamples(src.file, samples, buf.sampleRate, channels)
      }),
    )
    .then((lufs) => updateSource(src.id, { lufs: Number.isFinite(lufs) ? lufs : null }))
    .catch(() => updateSource(src.id, { lufs: null }))
}
