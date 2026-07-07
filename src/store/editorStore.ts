/**
 * editorStore.ts — the single source of truth for the editor.
 *
 * Holds the imported sources, both timeline tracks, the current selection, and
 * transport/tool/zoom state. High-frequency interactions (dragging clips,
 * scrubbing) read state via `useEditorStore.getState()` inside pointer handlers
 * and commit a single update on pointer-up, so they don't thrash React.
 */

import { create } from 'zustand'
import type { Clip, Source, TimelineTrack, Tool, TrackKind } from '../types'
import { formatTC } from '../lib/format'
import { nextZ, seedIds, uid } from '../lib/id'
import { linkedPartner, linksAtTime, splitLinkGroupAt, trackEnd } from '../lib/timeline'
import { rippleAddDissolve, rippleRemoveDissolve } from '../lib/transition'
import { clampGainDb, clampTargetLufs, DEFAULT_TARGET_LUFS } from '../lib/loudness'
import { clampFades } from '../lib/fade'
import { initialTheme, persistTheme, readStoredTheme, type Theme } from '../lib/theme'

/** Position + target clip for the clip right-click menu; null when closed. */
export interface ContextMenuState {
  clipId: string
  x: number
  y: number
}

/** The undoable "document" — the parts of state that edits change. */
interface Doc {
  sources: Source[]
  videoClips: Clip[]
  audioClips: Clip[]
  tracks: TimelineTrack[]
}

/** The two starter layers every fresh (or legacy) project gets. */
export const DEFAULT_TRACKS: TimelineTrack[] = [
  { id: 'v1', kind: 'video' },
  { id: 'a1', kind: 'audio' },
]

const HISTORY_LIMIT = 100

interface EditorState {
  // ── Model ──
  sources: Source[]
  videoClips: Clip[]
  audioClips: Clip[]
  /** Ordered timeline layers; within a kind, later = higher layer (V2 over V1). */
  tracks: TimelineTrack[]
  selection: Set<string> // selected clip ids
  selectedSrcId: string | null // source shown in the preview stage
  analyzerSrcId: string | null // source open in the analyzer panel (null = closed)
  contextMenu: ContextMenuState | null
  exportOpen: boolean // whether the export dialog is open

  // ── Undo/redo ──
  past: Doc[]
  future: Doc[]

  // ── View / transport ──
  tool: Tool
  pxPerSec: number
  playheadTime: number
  previewMuted: boolean
  theme: Theme
  themeExplicit: boolean // true once the user has manually toggled (stop following OS)

  // ── Editing defaults (app preferences, persisted across sessions) ──
  /** Loudness target (LUFS) that "Normalize" aims for; user-editable, shared by
   *  the clip and source level controls. */
  audioTargetLufs: number

  // ── Resizable panels (desktop/tablet; ignored in the mobile layout) ──
  binW: number // media-bin column width, px
  trackScale: number // timeline track-height multiplier (1 = default)
  inspectorW: number // right inspector width, px
  inspectorOpen: boolean // whether the right inspector is shown

  // ── App lock / status ──
  busy: boolean
  loadingMsg: string
  status: string

  // ── Undo/redo actions ──
  /** Capture the current document onto the undo stack (call before a mutating gesture). */
  snapshot: () => void
  undo: () => void
  redo: () => void

  /** Replace the document + view state from a restored session (clears history/selection). */
  hydrate: (doc: {
    sources: Source[]
    videoClips: Clip[]
    audioClips: Clip[]
    tracks?: TimelineTrack[]
    pxPerSec: number
    playheadTime: number
    selectedSrcId: string | null
    binW?: number
    trackScale?: number
    inspectorW?: number
    inspectorOpen?: boolean
    audioTargetLufs?: number
  }) => void

  // ── Source actions ──
  addSource: (src: Source) => void
  updateSource: (id: string, patch: Partial<Source>) => void
  /** Remove a source from the bin along with every clip that references it. */
  deleteMedia: (srcId: string) => void
  setStage: (srcId: string) => void
  openAnalyzer: (srcId: string) => void
  closeAnalyzer: () => void

  // ── Timeline actions ──
  /** Place a source's clips at `at`. `target` routes them onto specific tracks;
   *  omitted kinds land on the first (lowest) track of that kind. */
  placeSource: (srcId: string, at: number, target?: { videoTrackId?: string; audioTrackId?: string }) => void
  appendSource: (srcId: string) => void
  setClipStarts: (starts: Map<string, number>) => void
  /** Reassign clips to tracks (vertical drag). Does not snapshot — the caller
   *  snapshots once at the start of the drag, like setClipStarts. */
  setClipTracks: (assign: Map<string, string>) => void
  /** Append a new empty layer of `kind` (becomes the highest V / lowest A row). */
  addTrack: (kind: TrackKind) => void
  /** Remove a layer and every clip on it (min one track per kind is kept). */
  removeTrack: (trackId: string) => void
  /** Set the output gain (dB) on the given clips. Does not snapshot — the caller
   *  snapshots once at the start of an interaction (see the clip inspector). */
  setClipGain: (clipIds: Iterable<string>, gainDb: number) => void
  /** Set the fade-in and/or fade-out (seconds) on the given clips, each re-clamped
   *  to its own duration. Does not snapshot — the caller snapshots once at the
   *  start of the interaction (see the clip inspector), mirroring setClipGain. */
  setClipFades: (clipIds: Iterable<string>, fades: { fadeIn?: number; fadeOut?: number }) => void
  /** Add (or re-apply at a new length) a cross-dissolve into `clipId`'s group from
   *  the clip before it, rippling the group + everything after left to overlap.
   *  Returns false when there's no adjacent predecessor. Snapshots on success. */
  setClipTransition: (clipId: string, dur: number) => boolean
  /** Remove `clipId`'s dissolve, rippling the group + everything after back right. */
  removeClipTransition: (clipId: string) => void
  cutLinkedAt: (link: string, t: number) => boolean
  splitAtPlayhead: () => void
  deleteSelected: () => void
  clearTimeline: () => void
  /** Severs `clipId`'s linked A/V partner (if any) so the two can move/delete independently. */
  detachPartner: (clipId: string) => void
  /** Re-links a video clip and an audio clip (reversing a detach) at their current positions. */
  linkClips: (idA: string, idB: string) => void
  bringToFront: (clipId: string) => void
  sendToBack: (clipId: string) => void

  // ── Context menu ──
  openContextMenu: (clipId: string, x: number, y: number) => void
  closeContextMenu: () => void

  // ── Selection actions ──
  setSelection: (ids: Set<string>) => void
  selectOnly: (clipId: string) => void
  toggleSelect: (clipId: string) => void
  clearSelection: () => void

  // ── View actions ──
  setTool: (tool: Tool) => void
  setPxPerSec: (pxPerSec: number) => void
  setBinW: (px: number) => void
  setTrackScale: (scale: number) => void
  setInspectorW: (px: number) => void
  toggleInspector: () => void
  setPlayhead: (t: number) => void
  togglePreviewMuted: () => void
  /** Set the shared normalize target (LUFS); clamped to the sane range. */
  setAudioTargetLufs: (lufs: number) => void
  setExportOpen: (open: boolean) => void
  toggleTheme: () => void
  /** Follow an OS theme change — only applied while the user hasn't manually toggled. */
  followOsTheme: (theme: Theme) => void

  // ── Lock / status ──
  lockUI: (msg?: string) => void
  unlockUI: () => void
  setStatus: (status: string) => void
}

const sourceById = (sources: Source[], id: string | null) => (id ? sources.find((s) => s.id === id) : undefined)

export const useEditorStore = create<EditorState>((set, get) => ({
  sources: [],
  videoClips: [],
  audioClips: [],
  tracks: DEFAULT_TRACKS,
  selection: new Set(),
  selectedSrcId: null,
  analyzerSrcId: null,
  contextMenu: null,
  exportOpen: false,
  past: [],
  future: [],

  tool: 'select',
  pxPerSec: 40,
  binW: 260,
  trackScale: 1,
  inspectorW: 300,
  inspectorOpen: true,
  playheadTime: 0,
  previewMuted: false,
  theme: initialTheme(),
  themeExplicit: readStoredTheme() != null,
  audioTargetLufs: DEFAULT_TARGET_LUFS,

  busy: false,
  loadingMsg: 'Loading media…',
  status: 'Ready — import media to begin.',

  snapshot: () =>
    set((state) => ({
      past: [
        ...state.past,
        { sources: state.sources, videoClips: state.videoClips, audioClips: state.audioClips, tracks: state.tracks },
      ].slice(-HISTORY_LIMIT),
      future: [], // a new edit invalidates the redo stack
    })),

  undo: () =>
    set((state) => {
      const prev = state.past[state.past.length - 1]
      if (!prev) return {}
      const current: Doc = {
        sources: state.sources,
        videoClips: state.videoClips,
        audioClips: state.audioClips,
        tracks: state.tracks,
      }
      return {
        ...prev,
        past: state.past.slice(0, -1),
        future: [...state.future, current],
        selection: new Set(), // ids from the other timeline may not exist here
        contextMenu: null,
      }
    }),

  redo: () =>
    set((state) => {
      const next = state.future[state.future.length - 1]
      if (!next) return {}
      const current: Doc = {
        sources: state.sources,
        videoClips: state.videoClips,
        audioClips: state.audioClips,
        tracks: state.tracks,
      }
      return {
        ...next,
        past: [...state.past, current],
        future: state.future.slice(0, -1),
        selection: new Set(),
        contextMenu: null,
      }
    }),

  hydrate: (doc) => {
    // Re-seed the id/z counters past every restored id — they reset on reload,
    // and colliding ids break React keys and multi-select drags (see lib/id.ts).
    const allClips = [...doc.videoClips, ...doc.audioClips]
    // Guarantee at least one layer of each kind, whatever was persisted.
    const tracks = [...(doc.tracks ?? [])]
    if (!tracks.some((t) => t.kind === 'video')) tracks.unshift({ id: 'v1', kind: 'video' })
    if (!tracks.some((t) => t.kind === 'audio')) tracks.push({ id: 'a1', kind: 'audio' })
    seedIds(
      [...doc.sources.map((s) => s.id), ...tracks.map((t) => t.id), ...allClips.flatMap((c) => [c.id, c.link])],
      allClips.map((c) => c.z),
    )
    // Migrate legacy single-layer sessions: clips without a (valid) trackId land
    // on the first track of their kind.
    const firstOf = (kind: TrackKind) => tracks.find((t) => t.kind === kind)?.id ?? ''
    const valid = new Set(tracks.map((t) => t.id))
    const settle = (clips: Clip[], kind: TrackKind) =>
      clips.map((c) => (c.trackId && valid.has(c.trackId) ? c : { ...c, trackId: firstOf(kind) }))
    set({
      sources: doc.sources,
      videoClips: settle(doc.videoClips, 'video'),
      audioClips: settle(doc.audioClips, 'audio'),
      tracks,
      pxPerSec: doc.pxPerSec,
      playheadTime: doc.playheadTime,
      selectedSrcId: doc.selectedSrcId,
      ...(doc.binW != null ? { binW: doc.binW } : {}),
      ...(doc.trackScale != null ? { trackScale: doc.trackScale } : {}),
      ...(doc.inspectorW != null ? { inspectorW: doc.inspectorW } : {}),
      ...(doc.inspectorOpen != null ? { inspectorOpen: doc.inspectorOpen } : {}),
      ...(doc.audioTargetLufs != null ? { audioTargetLufs: clampTargetLufs(doc.audioTargetLufs) } : {}),
      // A restored session starts with a clean slate for transient/history state.
      selection: new Set(),
      past: [],
      future: [],
      contextMenu: null,
      analyzerSrcId: null,
    })
  },

  addSource: (src) =>
    set((state) => ({
      sources: [...state.sources, src],
      // First source imported becomes the preview stage automatically.
      selectedSrcId: state.selectedSrcId ?? src.id,
    })),

  updateSource: (id, patch) =>
    set((state) => ({
      sources: state.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    })),

  deleteMedia: (srcId) => {
    const state = get()
    if (!state.sources.some((s) => s.id === srcId)) return
    state.snapshot()
    const removedClipIds = new Set(
      [...state.videoClips, ...state.audioClips].filter((c) => c.sourceId === srcId).map((c) => c.id),
    )
    set((s) => ({
      sources: s.sources.filter((src) => src.id !== srcId),
      videoClips: s.videoClips.filter((c) => c.sourceId !== srcId),
      audioClips: s.audioClips.filter((c) => c.sourceId !== srcId),
      selection: new Set([...s.selection].filter((id) => !removedClipIds.has(id))),
      selectedSrcId: s.selectedSrcId === srcId ? null : s.selectedSrcId,
      analyzerSrcId: s.analyzerSrcId === srcId ? null : s.analyzerSrcId,
    }))
  },

  setStage: (srcId) => set({ selectedSrcId: srcId }),
  openAnalyzer: (srcId) => set({ analyzerSrcId: srcId }),
  closeAnalyzer: () => set({ analyzerSrcId: null }),

  placeSource: (srcId, at, target) => {
    const src = sourceById(get().sources, srcId)
    if (!src) return
    get().snapshot()
    const start = Math.max(0, at)
    const link = uid() // a file's video + audio clips share a link id
    set((state) => {
      const videoClips = [...state.videoClips]
      const audioClips = [...state.audioClips]
      // Route each half onto the requested track (validated), else the first
      // (lowest) layer of its kind.
      const trackFor = (kind: TrackKind, wanted?: string) =>
        (wanted && state.tracks.find((t) => t.id === wanted && t.kind === kind)?.id) ??
        state.tracks.find((t) => t.kind === kind)?.id ??
        ''
      // New clips inherit the source's current gain as a starting point; each
      // clip is independently adjustable from the timeline afterwards.
      const seed = { link, start, in: 0, dur: src.duration, gainDb: src.gainDb }
      if (src.isVideo)
        videoClips.push({ id: uid(), sourceId: src.id, z: nextZ(), trackId: trackFor('video', target?.videoTrackId), ...seed })
      if (src.hasAudio)
        audioClips.push({ id: uid(), sourceId: src.id, z: nextZ(), trackId: trackFor('audio', target?.audioTrackId), ...seed })
      return { videoClips, audioClips, selectedSrcId: src.id }
    })
  },

  appendSource: (srcId) => {
    const { videoClips, audioClips, placeSource } = get()
    placeSource(srcId, Math.max(trackEnd(videoClips), trackEnd(audioClips)))
  },

  setClipStarts: (starts) =>
    set((state) => {
      const apply = (clips: Clip[]) => clips.map((c) => (starts.has(c.id) ? { ...c, start: starts.get(c.id)! } : c))
      return { videoClips: apply(state.videoClips), audioClips: apply(state.audioClips) }
    }),

  setClipTracks: (assign) =>
    set((state) => {
      // Only accept moves onto an existing track of the clip's own kind.
      const kindOf = new Map(state.tracks.map((t) => [t.id, t.kind]))
      const apply = (clips: Clip[], kind: TrackKind) =>
        clips.map((c) => {
          const to = assign.get(c.id)
          return to && to !== c.trackId && kindOf.get(to) === kind ? { ...c, trackId: to } : c
        })
      return { videoClips: apply(state.videoClips, 'video'), audioClips: apply(state.audioClips, 'audio') }
    }),

  addTrack: (kind) => {
    get().snapshot()
    set((state) => {
      const track: TimelineTrack = { id: uid(), kind }
      // Insert after the last track of the same kind, so within-kind order stays
      // contiguous and the new layer becomes the highest of its kind.
      const idx = state.tracks.map((t) => t.kind).lastIndexOf(kind)
      const tracks = [...state.tracks]
      tracks.splice(idx < 0 ? tracks.length : idx + 1, 0, track)
      return { tracks }
    })
  },

  removeTrack: (trackId) => {
    const state = get()
    const track = state.tracks.find((t) => t.id === trackId)
    if (!track) return
    // Never drop the last layer of a kind.
    if (state.tracks.filter((t) => t.kind === track.kind).length <= 1) return
    get().snapshot()
    set((s) => {
      const removed = new Set(
        [...s.videoClips, ...s.audioClips].filter((c) => c.trackId === trackId).map((c) => c.id),
      )
      return {
        tracks: s.tracks.filter((t) => t.id !== trackId),
        videoClips: s.videoClips.filter((c) => c.trackId !== trackId),
        audioClips: s.audioClips.filter((c) => c.trackId !== trackId),
        selection: new Set([...s.selection].filter((id) => !removed.has(id))),
      }
    })
  },

  setClipGain: (clipIds, gainDb) =>
    set((state) => {
      const ids = new Set(clipIds)
      const g = clampGainDb(gainDb)
      const apply = (clips: Clip[]) => clips.map((c) => (ids.has(c.id) ? { ...c, gainDb: g } : c))
      return { videoClips: apply(state.videoClips), audioClips: apply(state.audioClips) }
    }),

  setClipFades: (clipIds, fades) =>
    set((state) => {
      const ids = new Set(clipIds)
      const apply = (clips: Clip[]) =>
        clips.map((c) => {
          if (!ids.has(c.id)) return c
          const next = clampFades(
            c.dur,
            fades.fadeIn ?? c.fadeIn ?? 0,
            fades.fadeOut ?? c.fadeOut ?? 0,
          )
          return { ...c, fadeIn: next.fadeIn, fadeOut: next.fadeOut }
        })
      return { videoClips: apply(state.videoClips), audioClips: apply(state.audioClips) }
    }),

  setClipTransition: (clipId, dur) => {
    const s = get()
    let video = s.videoClips
    let audio = s.audioClips
    const clip = [...video, ...audio].find((c) => c.id === clipId)
    if (!clip) return false
    // Re-applying at a new length: undo the existing ripple first so the geometry
    // is recomputed from the clean, pre-transition positions (keeps it stable).
    if (clip.transitionIn) {
      const back = rippleRemoveDissolve(video, audio, clipId)
      video = back.video
      audio = back.audio
    }
    const res = rippleAddDissolve(video, audio, clipId, dur)
    if (!res) return false
    get().snapshot()
    set({ videoClips: res.video, audioClips: res.audio, selection: new Set(res.groupIds) })
    return true
  },

  removeClipTransition: (clipId) => {
    const s = get()
    const clip = [...s.videoClips, ...s.audioClips].find((c) => c.id === clipId)
    if (!clip?.transitionIn) return
    get().snapshot()
    const res = rippleRemoveDissolve(s.videoClips, s.audioClips, clipId)
    set({ videoClips: res.video, audioClips: res.audio })
  },

  cutLinkedAt: (link, t) => {
    const { videoClips, audioClips } = get()
    const res = splitLinkGroupAt(videoClips, audioClips, link, t)
    if (!res.rights.length) return false
    get().snapshot()
    set({
      videoClips: res.video,
      audioClips: res.audio,
      selection: new Set(res.rights.map((r) => r.id)), // select the new right segment(s)
    })
    return true
  },

  splitAtPlayhead: () => {
    const { videoClips, audioClips, playheadTime } = get()
    const links = linksAtTime(videoClips, audioClips, playheadTime)
    let video = videoClips
    let audio = audioClips
    let didCut = false
    for (const link of links) {
      const res = splitLinkGroupAt(video, audio, link, playheadTime)
      if (res.rights.length) {
        video = res.video
        audio = res.audio
        didCut = true
      }
    }
    if (didCut) {
      get().snapshot()
      set({ videoClips: video, audioClips: audio, selection: new Set(), status: `Split at ${formatTC(playheadTime)}` })
    }
  },

  deleteSelected: () => {
    if (!get().selection.size) return
    get().snapshot()
    set((state) => ({
      videoClips: state.videoClips.filter((c) => !state.selection.has(c.id)),
      audioClips: state.audioClips.filter((c) => !state.selection.has(c.id)),
      selection: new Set(),
    }))
  },

  clearTimeline: () => {
    const { videoClips, audioClips } = get()
    if (!videoClips.length && !audioClips.length) return
    get().snapshot()
    set({ videoClips: [], audioClips: [], selection: new Set(), playheadTime: 0 })
  },

  detachPartner: (clipId) => {
    const s = get()
    const clip = [...s.videoClips, ...s.audioClips].find((c) => c.id === clipId)
    if (!clip) return
    const partner = linkedPartner(clip, s.videoClips, s.audioClips)
    if (!partner) return
    get().snapshot()
    set((state) => {
      const onVideoTrack = state.videoClips.some((c) => c.id === clipId)
      const newLink = uid()
      const patch = (clips: Clip[]) => clips.map((c) => (c.id === partner.id ? { ...c, link: newLink } : c))
      // Drop the now-detached partner from the selection — otherwise the stale
      // "these were linked" grouping lingers and gets re-added on the next drag.
      const selection = new Set(state.selection)
      selection.delete(partner.id)
      return onVideoTrack
        ? { audioClips: patch(state.audioClips), selection }
        : { videoClips: patch(state.videoClips), selection }
    })
  },

  linkClips: (idA, idB) => {
    const s = get()
    const aVideo = s.videoClips.some((c) => c.id === idA)
    const bVideo = s.videoClips.some((c) => c.id === idB)
    const aFound = aVideo || s.audioClips.some((c) => c.id === idA)
    const bFound = bVideo || s.audioClips.some((c) => c.id === idB)
    if (!aFound || !bFound || aVideo === bVideo) return // need exactly one video + one audio
    get().snapshot()
    set((state) => {
      const newLink = uid()
      const relink = (clips: Clip[]) =>
        clips.map((c) => (c.id === idA || c.id === idB ? { ...c, link: newLink } : c))
      // Positions are left untouched — the clips link wherever they now sit.
      return {
        videoClips: relink(state.videoClips),
        audioClips: relink(state.audioClips),
        selection: new Set([idA, idB]),
      }
    })
  },

  bringToFront: (clipId) => {
    get().snapshot()
    set((state) => {
      const onVideoTrack = state.videoClips.some((c) => c.id === clipId)
      const all = onVideoTrack ? state.videoClips : state.audioClips
      // Stacking order is a within-track affair — only same-layer clips compete.
      const target = all.find((c) => c.id === clipId)
      const clips = target ? all.filter((c) => c.trackId === target.trackId) : all
      // Seed from an existing clip's z, not 0 — a phantom 0 would skew the
      // result whenever every real z is already above (or below) zero.
      const maxZ = clips.reduce((m, c) => Math.max(m, c.z), clips[0]?.z ?? 0)
      const bump = (arr: Clip[]) => arr.map((c) => (c.id === clipId ? { ...c, z: maxZ + 1 } : c))
      return onVideoTrack ? { videoClips: bump(state.videoClips) } : { audioClips: bump(state.audioClips) }
    })
  },

  sendToBack: (clipId) => {
    get().snapshot()
    set((state) => {
      const onVideoTrack = state.videoClips.some((c) => c.id === clipId)
      const all = onVideoTrack ? state.videoClips : state.audioClips
      const target = all.find((c) => c.id === clipId)
      const clips = target ? all.filter((c) => c.trackId === target.trackId) : all
      const minZ = clips.reduce((m, c) => Math.min(m, c.z), clips[0]?.z ?? 0)
      const bump = (arr: Clip[]) => arr.map((c) => (c.id === clipId ? { ...c, z: minZ - 1 } : c))
      return onVideoTrack ? { videoClips: bump(state.videoClips) } : { audioClips: bump(state.audioClips) }
    })
  },

  openContextMenu: (clipId, x, y) => set({ contextMenu: { clipId, x, y } }),
  closeContextMenu: () => set({ contextMenu: null }),

  setSelection: (ids) => set({ selection: ids }),

  selectOnly: (clipId) =>
    set((state) => {
      const clip = [...state.videoClips, ...state.audioClips].find((c) => c.id === clipId)
      return { selection: new Set([clipId]), selectedSrcId: clip ? clip.sourceId : state.selectedSrcId }
    }),

  toggleSelect: (clipId) =>
    set((state) => {
      const selection = new Set(state.selection)
      if (selection.has(clipId)) selection.delete(clipId)
      else selection.add(clipId)
      return { selection }
    }),

  clearSelection: () => set({ selection: new Set() }),

  setTool: (tool) => set({ tool }),
  setPxPerSec: (pxPerSec) => set({ pxPerSec }),
  setBinW: (px) => set({ binW: Math.max(190, Math.min(560, px)) }),
  setTrackScale: (scale) => set({ trackScale: Math.max(0.55, Math.min(2.8, scale)) }),
  setInspectorW: (px) => set({ inspectorW: Math.max(240, Math.min(520, px)) }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setPlayhead: (t) => set({ playheadTime: Math.max(0, t) }),
  togglePreviewMuted: () => set((state) => ({ previewMuted: !state.previewMuted })),
  setAudioTargetLufs: (lufs) => set({ audioTargetLufs: clampTargetLufs(lufs) }),
  setExportOpen: (open) => set({ exportOpen: open }),

  toggleTheme: () =>
    set((state) => {
      const theme: Theme = state.theme === 'dark' ? 'light' : 'dark'
      persistTheme(theme)
      return { theme, themeExplicit: true }
    }),
  followOsTheme: (theme) => set((state) => (state.themeExplicit ? {} : { theme })),

  lockUI: (msg) => set({ busy: true, loadingMsg: msg || 'Loading media…' }),
  unlockUI: () => set({ busy: false }),
  setStatus: (status) => set({ status }),
}))

/** Non-reactive lookup for use inside event handlers. */
export const getSourceById = (id: string | null): Source | undefined => sourceById(useEditorStore.getState().sources, id)
