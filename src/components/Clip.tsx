import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { hsl } from '../lib/color'
import { expandToLinkGroups, snapEdges } from '../lib/timeline'
import { drawClipDecoration } from '../lib/clipCanvas'
import type { Clip as ClipModel } from '../types'

interface ClipProps {
  clip: ClipModel
  isVideo: boolean
}

// z-index headroom above the highest clip.z so a selected/dragging clip always
// paints above the rest, without fighting the per-clip stacking-order value.
const SELECTED_Z_BOOST = 500
const DRAGGING_Z_BOOST = 1000

/**
 * Decide the selection at link-group granularity, so a clip and its linked A/V
 * partner are always selected (and later dragged or deleted) together: shift
 * toggles the whole group; a plain click/right-click on an unselected group
 * selects just that group; interacting with an already-selected group keeps
 * the whole selection (so a larger multi-clip selection stays draggable).
 */
function groupSelect(current: Set<string>, allClips: ClipModel[], clipId: string, additive: boolean): Set<string> {
  const group = expandToLinkGroups(allClips, new Set([clipId]))
  if (additive) {
    const next = new Set(current)
    const groupSelected = [...group].every((id) => next.has(id))
    for (const id of group) (groupSelected ? next.delete(id) : next.add(id))
    return next
  }
  if (![...group].some((id) => current.has(id))) return new Set(group)
  const next = new Set(current)
  for (const id of group) next.add(id)
  return next
}

/** A single clip on a track: positioned block with a filmstrip/waveform canvas. */
export function Clip({ clip, isVideo }: ClipProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const source = useEditorStore((s) => s.sources.find((x) => x.id === clip.sourceId))
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const selected = useEditorStore((s) => s.selection.has(clip.id))

  // Redraw the filmstrip/waveform when zoom, trim, or decoded data changes —
  // and whenever the canvas box itself resizes (track-height scaling, window
  // resizes), so the backing store is re-rendered at the new size instead of
  // being CSS-stretched into a distorted aspect ratio.
  // (Position changes alone don't need a redraw — only the block's `left`.)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !source) return
    drawClipDecoration(canvas, clip, source, isVideo)
    const ro = new ResizeObserver(() => drawClipDecoration(canvas, clip, source, isVideo))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [source, pxPerSec, clip.dur, clip.in, clip.gainDb, isVideo])

  if (!source) return null

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const el = elRef.current!
    const store = useEditorStore.getState()
    const tool = store.tool
    const clipId = clip.id

    let selectedIds = store.selection
    if (tool === 'select') {
      const allClips = [...store.videoClips, ...store.audioClips]
      selectedIds = groupSelect(store.selection, allClips, clipId, e.shiftKey)
      store.setSelection(selectedIds)
      store.setStage(clip.sourceId)
    }

    const startX = e.clientX
    const startY = e.clientY
    const origins = new Map<string, number>()
    for (const c of [...store.videoClips, ...store.audioClips]) {
      if (selectedIds.has(c.id)) origins.set(c.id, c.start)
    }
    // Vertical drag context: lane order per kind, each selected clip's original
    // lane, and the rendered lane rects (fixed for the duration of the drag).
    const videoOrder = store.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
    const audioOrder = store.tracks.filter((t) => t.kind === 'audio').map((t) => t.id)
    const isVideoId = new Set(store.videoClips.map((c) => c.id))
    const origTracks = new Map<string, string>()
    for (const c of [...store.videoClips, ...store.audioClips]) {
      if (selectedIds.has(c.id)) origTracks.set(c.id, c.trackId)
    }
    const laneRects = [...document.querySelectorAll<HTMLElement>('.track[data-track-id]')].map((row) => {
      const r = row.getBoundingClientRect()
      return { id: row.dataset.trackId!, kind: row.dataset.kind!, top: r.top, bottom: r.bottom }
    })
    let moved = false
    let didSnapshot = false // capture one undo entry per drag, only once it actually moves
    el.setPointerCapture(e.pointerId)

    // Touch has no right-click: a 500ms hold without moving opens the context
    // menu instead of starting a drag.
    const menuX = e.clientX
    const menuY = e.clientY
    let longPressTimer: ReturnType<typeof setTimeout> | null =
      e.pointerType === 'touch'
        ? setTimeout(() => {
            longPressTimer = null
            if (moved) return
            el.releasePointerCapture(e.pointerId)
            el.removeEventListener('pointermove', onMove)
            el.removeEventListener('pointerup', onUp)
            const s = useEditorStore.getState()
            const allClips = [...s.videoClips, ...s.audioClips]
            s.setSelection(groupSelect(s.selection, allClips, clipId, false))
            s.setStage(clip.sourceId)
            s.openContextMenu(clipId, menuX, menuY)
          }, 500)
        : null
    const cancelLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
    }

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved = true
        cancelLongPress()
      }
      if (tool !== 'select' || !moved) return
      if (!didSnapshot) {
        useEditorStore.getState().snapshot()
        didSnapshot = true
      }

      el.classList.add('dragging')
      el.style.zIndex = String(DRAGGING_Z_BOOST)
      const s = useEditorStore.getState()
      const px = s.pxPerSec
      const grabbedBase = origins.get(clipId) ?? clip.start
      const rawStart = Math.max(0, grabbedBase + dx / px)
      // Snap using the grabbed clip, then apply the same delta to the group.
      const snapped = snapEdges(
        [...s.videoClips, ...s.audioClips],
        rawStart,
        clip,
        new Set(origins.keys()),
        px,
        s.playheadTime,
      )
      let delta = snapped - grabbedBase
      // Clamp only at the left (0); the domain expands to the right as needed.
      let lo = -Infinity
      for (const base of origins.values()) lo = Math.max(lo, -base)
      delta = Math.max(delta, lo)

      const starts = new Map<string, number>()
      for (const [id, base] of origins) starts.set(id, base + delta)
      s.setClipStarts(starts)

      // Vertical: dragging into another lane of the same kind moves the whole
      // selection by the grabbed clip's lane delta (each clip clamped to a real
      // lane of its own kind; linked partners shift among their own lanes).
      const kind = isVideo ? 'video' : 'audio'
      const hovered = laneRects.find((r) => r.kind === kind && ev.clientY >= r.top && ev.clientY <= r.bottom)
      if (hovered) {
        const grabbedOrder = isVideo ? videoOrder : audioOrder
        const laneDelta = grabbedOrder.indexOf(hovered.id) - grabbedOrder.indexOf(origTracks.get(clipId) ?? '')
        const assign = new Map<string, string>()
        for (const [id, orig] of origTracks) {
          const order = isVideoId.has(id) ? videoOrder : audioOrder
          const idx = order.indexOf(orig)
          if (idx < 0) continue
          assign.set(id, order[Math.max(0, Math.min(order.length - 1, idx + laneDelta))])
        }
        s.setClipTracks(assign)
      }
    }

    const onUp = () => {
      cancelLongPress()
      el.releasePointerCapture(e.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.classList.remove('dragging')
      el.style.zIndex = ''

      if (tool === 'cut' && !moved) {
        // Cut lands on the playhead; the linked A/V partner is cut too.
        const s = useEditorStore.getState()
        if (!s.cutLinkedAt(clip.link, s.playheadTime)) {
          s.setStatus('Move the red playhead over the clip, then cut.')
        }
      }
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const store = useEditorStore.getState()
    const allClips = [...store.videoClips, ...store.audioClips]
    const next = groupSelect(store.selection, allClips, clip.id, false)
    store.setSelection(next)
    store.setStage(clip.sourceId)
    store.openContextMenu(clip.id, e.clientX, e.clientY)
  }

  return (
    <div
      ref={elRef}
      className={'clip' + (selected ? ' sel' : '')}
      style={{
        left: clip.start * pxPerSec,
        width: Math.max(2, clip.dur * pxPerSec),
        background: hsl(source.color, isVideo ? 0.3 : 0.22),
        borderColor: hsl(source.color, 0.85),
        zIndex: clip.z + (selected ? SELECTED_Z_BOOST : 0),
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <canvas className="clip-canvas" ref={canvasRef} />
      {clip.transitionIn && (
        <div
          className="clip-transition"
          style={{ width: Math.max(3, clip.transitionIn.dur * pxPerSec) }}
          title={`Dissolve · ${clip.transitionIn.dur.toFixed(2)}s`}
          aria-hidden
        />
      )}
      <div className="clip-label">
        <span className="clip-name">{source.name}</span>
        {!isVideo && clip.gainDb !== 0 && (
          <span className="clip-gain">
            {clip.gainDb > 0 ? '+' : ''}
            {clip.gainDb.toFixed(1)} dB
          </span>
        )}
      </div>
    </div>
  )
}
