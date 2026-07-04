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
    .then((lufs) => updateSource(src.id, { lufs: Number.isFinite(lufs) ? lufs : null }))
    .catch(() => updateSource(src.id, { lufs: null }))
}
