/**
 * persist.ts — save & restore the whole editing session across refreshes.
 *
 * Two stores, by data shape:
 *  - localStorage: the small JSON "project" — source metadata, both clip tracks,
 *    and view state (zoom, playhead). Fast, synchronous, tiny.
 *  - IndexedDB (see lib/idb): the actual media file bytes, which the browser
 *    won't let us reopen from disk after a refresh. Keyed by source id.
 *
 * Decoded decorations (waveform peaks, thumbnails) are never persisted — they're
 * re-derived from the restored file bytes on load. Loudness is persisted (it's a
 * slow measurement) and only re-measured if it wasn't known yet.
 *
 * Saving is debounced and runs automatically after any change; restore runs once
 * at startup, before autosave is armed, so a fresh empty store can't clobber it.
 */

import { useEditorStore } from './editorStore'
import { idbPutFile, idbGetFile, idbDeleteFile, idbKeys, idbClear } from '../lib/idb'
import type { Clip, HSL, MediaInfo, Source } from '../types'

const KEY = 'wazplay-project'
const VERSION = 1
const DEBOUNCE_MS = 800

/** The JSON-safe shape of a source (no File / no decoded peaks or thumbs). */
interface PersistedSource {
  id: string
  name: string
  color: HSL
  isVideo: boolean
  hasAudio: boolean
  info: MediaInfo | null
  duration: number
  width: number
  height: number
  /** Finite integrated loudness if measured; null means "re-measure on restore". */
  lufs: number | null
  gainDb: number
}

interface PersistedProject {
  version: number
  sources: PersistedSource[]
  videoClips: Clip[]
  audioClips: Clip[]
  pxPerSec: number
  playheadTime: number
  selectedSrcId: string | null
  binW: number
  trackScale: number
  inspectorW: number
  inspectorOpen: boolean
}

/** Snapshot the persistable slice of the store to a JSON-safe project. */
function snapshot(): PersistedProject {
  const s = useEditorStore.getState()
  return {
    version: VERSION,
    sources: s.sources.map((src) => ({
      id: src.id,
      name: src.name,
      color: src.color,
      isVideo: src.isVideo,
      hasAudio: src.hasAudio,
      info: src.info,
      duration: src.duration,
      width: src.width,
      height: src.height,
      lufs: typeof src.lufs === 'number' && Number.isFinite(src.lufs) ? src.lufs : null,
      gainDb: src.gainDb,
    })),
    videoClips: s.videoClips,
    audioClips: s.audioClips,
    pxPerSec: s.pxPerSec,
    playheadTime: s.playheadTime,
    selectedSrcId: s.selectedSrcId,
    binW: s.binW,
    trackScale: s.trackScale,
    inspectorW: s.inspectorW,
    inspectorOpen: s.inspectorOpen,
  }
}

/** Write the project JSON + reconcile media blobs in IndexedDB. */
async function saveNow(): Promise<void> {
  const project = snapshot()
  try {
    localStorage.setItem(KEY, JSON.stringify(project))
  } catch {
    /* storage full / disabled — skip the JSON, still try blobs */
  }

  // Reconcile blobs: store files we don't have yet, drop files no longer used.
  try {
    const wanted = new Set(project.sources.map((s) => s.id))
    const stored = new Set(await idbKeys())
    const byId = new Map(useEditorStore.getState().sources.map((s) => [s.id, s.file]))
    await Promise.all([
      ...[...wanted].filter((id) => !stored.has(id) && byId.has(id)).map((id) => idbPutFile(id, byId.get(id)!)),
      ...[...stored].filter((id) => !wanted.has(id)).map((id) => idbDeleteFile(id)),
    ])
  } catch {
    /* quota exceeded or IDB unavailable — project JSON still saved */
  }
}

/** Rebuild live Source objects from a persisted project + their IDB blobs. */
async function loadPersisted(): Promise<PersistedProject | null> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const project = JSON.parse(raw) as PersistedProject
    if (project.version !== VERSION || !Array.isArray(project.sources)) return null
    return project
  } catch {
    return null
  }
}

/**
 * Restore a saved session into the store (if any), re-derive decorations, then
 * arm debounced autosave. Safe to call once at startup.
 */
export async function initPersistence(): Promise<void> {
  // Lazy import to avoid a static import cycle (decorate → store → persist).
  const { decorateSource, measureLoudness } = await import('../lib/decorate')

  try {
    const project = await loadPersisted()
    if (project) {
      // Pair each persisted source with its stored bytes; drop any whose blob is
      // gone, and drop clips that referenced a dropped source.
      const files = await Promise.all(project.sources.map((s) => idbGetFile(s.id).catch(() => undefined)))
      const sources: Source[] = []
      project.sources.forEach((ps, i) => {
        const file = files[i]
        if (!file) return
        sources.push({
          id: ps.id,
          file,
          name: ps.name,
          color: ps.color,
          isVideo: ps.isVideo,
          hasAudio: ps.hasAudio,
          info: ps.info,
          duration: ps.duration,
          width: ps.width,
          height: ps.height,
          thumbs: null,
          peaks: null,
          // A finite persisted value shows immediately; otherwise re-measure.
          lufs: ps.lufs == null ? (ps.hasAudio ? undefined : null) : ps.lufs,
          gainDb: ps.gainDb,
        })
      })

      const liveIds = new Set(sources.map((s) => s.id))
      const keepClip = (c: Clip) => liveIds.has(c.sourceId)
      useEditorStore.getState().hydrate({
        sources,
        videoClips: project.videoClips.filter(keepClip),
        audioClips: project.audioClips.filter(keepClip),
        pxPerSec: project.pxPerSec,
        playheadTime: project.playheadTime,
        selectedSrcId: liveIds.has(project.selectedSrcId ?? '') ? project.selectedSrcId : (sources[0]?.id ?? null),
        binW: project.binW,
        trackScale: project.trackScale,
        inspectorW: project.inspectorW,
        inspectorOpen: project.inspectorOpen,
      })

      // Re-derive peaks + thumbnails (never persisted); re-measure loudness only
      // when it wasn't already known. All in the background — the UI is usable.
      for (const src of sources) {
        void decorateSource(src)
        if (src.lufs === undefined) measureLoudness(src)
      }
      if (sources.length) {
        useEditorStore.getState().setStatus(`Restored ${sources.length} source${sources.length === 1 ? '' : 's'} from last session.`)
      }
    }
  } catch {
    /* corrupt/unavailable storage — start fresh */
  }

  armAutosave()
}

let timer: ReturnType<typeof setTimeout> | null = null
function armAutosave(): void {
  useEditorStore.subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void saveNow()
    }, DEBOUNCE_MS)
  })
}

/** Erase the saved session (JSON + all media blobs). */
export async function clearPersisted(): Promise<void> {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  await idbClear().catch(() => {})
}
