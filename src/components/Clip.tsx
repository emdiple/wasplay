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

  // Redraw the filmstrip/waveform when zoom, trim, or decoded data changes.
  // (Position changes alone don't need a redraw — only the block's `left`.)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && source) drawClipDecoration(canvas, clip, source, isVideo)
  }, [source, pxPerSec, clip.dur, clip.in, isVideo])

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
    const origins = new Map<string, number>()
    for (const c of [...store.videoClips, ...store.audioClips]) {
      if (selectedIds.has(c.id)) origins.set(c.id, c.start)
    }
    let moved = false
    el.setPointerCapture(e.pointerId)

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (Math.abs(dx) > 3) moved = true
      if (tool !== 'select' || !moved) return

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
    }

    const onUp = () => {
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
      <div className="clip-label">{source.name}</div>
    </div>
  )
}
