/**
 * editorStore.ts — the single source of truth for the editor.
 *
 * Holds the imported sources, both timeline tracks, the current selection, and
 * transport/tool/zoom state. High-frequency interactions (dragging clips,
 * scrubbing) read state via `useEditorStore.getState()` inside pointer handlers
 * and commit a single update on pointer-up, so they don't thrash React.
 */

import { create } from 'zustand'
import type { Clip, Source, Tool } from '../types'
import { formatTC } from '../lib/format'
import { nextZ, uid } from '../lib/id'
import { linkedPartner, linksAtTime, splitLinkGroupAt, trackEnd } from '../lib/timeline'
import { initialTheme, persistTheme, readStoredTheme, type Theme } from '../lib/theme'

/** Position + target clip for the clip right-click menu; null when closed. */
export interface ContextMenuState {
  clipId: string
  x: number
  y: number
}

interface EditorState {
  // ── Model ──
  sources: Source[]
  videoClips: Clip[]
  audioClips: Clip[]
  selection: Set<string> // selected clip ids
  selectedSrcId: string | null // source shown in the preview stage
  analyzerSrcId: string | null // source open in the analyzer panel (null = closed)
  contextMenu: ContextMenuState | null
  exportOpen: boolean // whether the export dialog is open

  // ── View / transport ──
  tool: Tool
  pxPerSec: number
  playheadTime: number
  previewMuted: boolean
  theme: Theme
  themeExplicit: boolean // true once the user has manually toggled (stop following OS)

  // ── App lock / status ──
  busy: boolean
  loadingMsg: string
  status: string

  // ── Source actions ──
  addSource: (src: Source) => void
  updateSource: (id: string, patch: Partial<Source>) => void
  setStage: (srcId: string) => void
  openAnalyzer: (srcId: string) => void
  closeAnalyzer: () => void

  // ── Timeline actions ──
  placeSource: (srcId: string, at: number) => void
  appendSource: (srcId: string) => void
  setClipStarts: (starts: Map<string, number>) => void
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
  setPlayhead: (t: number) => void
  togglePreviewMuted: () => void
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
  selection: new Set(),
  selectedSrcId: null,
  analyzerSrcId: null,
  contextMenu: null,
  exportOpen: false,

  tool: 'select',
  pxPerSec: 40,
  playheadTime: 0,
  previewMuted: false,
  theme: initialTheme(),
  themeExplicit: readStoredTheme() != null,

  busy: false,
  loadingMsg: 'Loading media…',
  status: 'Ready — import media to begin.',

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

  setStage: (srcId) => set({ selectedSrcId: srcId }),
  openAnalyzer: (srcId) => set({ analyzerSrcId: srcId }),
  closeAnalyzer: () => set({ analyzerSrcId: null }),

  placeSource: (srcId, at) => {
    const src = sourceById(get().sources, srcId)
    if (!src) return
    const start = Math.max(0, at)
    const link = uid() // a file's video + audio clips share a link id
    set((state) => {
      const videoClips = [...state.videoClips]
      const audioClips = [...state.audioClips]
      if (src.isVideo) videoClips.push({ id: uid(), sourceId: src.id, link, start, in: 0, dur: src.duration, z: nextZ() })
      if (src.hasAudio) audioClips.push({ id: uid(), sourceId: src.id, link, start, in: 0, dur: src.duration, z: nextZ() })
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

  cutLinkedAt: (link, t) => {
    const { videoClips, audioClips } = get()
    const res = splitLinkGroupAt(videoClips, audioClips, link, t)
    if (!res.rights.length) return false
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
      set({ videoClips: video, audioClips: audio, selection: new Set(), status: `Split at ${formatTC(playheadTime)}` })
    }
  },

  deleteSelected: () =>
    set((state) => {
      if (!state.selection.size) return {}
      return {
        videoClips: state.videoClips.filter((c) => !state.selection.has(c.id)),
        audioClips: state.audioClips.filter((c) => !state.selection.has(c.id)),
        selection: new Set(),
      }
    }),

  clearTimeline: () => set({ videoClips: [], audioClips: [], selection: new Set(), playheadTime: 0 }),

  detachPartner: (clipId) =>
    set((state) => {
      const clip = [...state.videoClips, ...state.audioClips].find((c) => c.id === clipId)
      if (!clip) return {}
      const partner = linkedPartner(clip, state.videoClips, state.audioClips)
      if (!partner) return {}
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
    }),

  linkClips: (idA, idB) =>
    set((state) => {
      const aVideo = state.videoClips.some((c) => c.id === idA)
      const bVideo = state.videoClips.some((c) => c.id === idB)
      const aFound = aVideo || state.audioClips.some((c) => c.id === idA)
      const bFound = bVideo || state.audioClips.some((c) => c.id === idB)
      if (!aFound || !bFound || aVideo === bVideo) return {} // need exactly one video + one audio
      const newLink = uid()
      const relink = (clips: Clip[]) =>
        clips.map((c) => (c.id === idA || c.id === idB ? { ...c, link: newLink } : c))
      // Positions are left untouched — the clips link wherever they now sit.
      return {
        videoClips: relink(state.videoClips),
        audioClips: relink(state.audioClips),
        selection: new Set([idA, idB]),
      }
    }),

  bringToFront: (clipId) =>
    set((state) => {
      const onVideoTrack = state.videoClips.some((c) => c.id === clipId)
      const clips = onVideoTrack ? state.videoClips : state.audioClips
      // Seed from an existing clip's z, not 0 — a phantom 0 would skew the
      // result whenever every real z is already above (or below) zero.
      const maxZ = clips.reduce((m, c) => Math.max(m, c.z), clips[0]?.z ?? 0)
      const bump = (arr: Clip[]) => arr.map((c) => (c.id === clipId ? { ...c, z: maxZ + 1 } : c))
      return onVideoTrack ? { videoClips: bump(state.videoClips) } : { audioClips: bump(state.audioClips) }
    }),

  sendToBack: (clipId) =>
    set((state) => {
      const onVideoTrack = state.videoClips.some((c) => c.id === clipId)
      const clips = onVideoTrack ? state.videoClips : state.audioClips
      const minZ = clips.reduce((m, c) => Math.min(m, c.z), clips[0]?.z ?? 0)
      const bump = (arr: Clip[]) => arr.map((c) => (c.id === clipId ? { ...c, z: minZ - 1 } : c))
      return onVideoTrack ? { videoClips: bump(state.videoClips) } : { audioClips: bump(state.audioClips) }
    }),

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
  setPlayhead: (t) => set({ playheadTime: Math.max(0, t) }),
  togglePreviewMuted: () => set((state) => ({ previewMuted: !state.previewMuted })),
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
