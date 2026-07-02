import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useEditorStore } from '../store/editorStore'
import { expandToLinkGroups } from '../lib/timeline'
import type { Clip } from '../types'

export interface MarqueeRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Rubber-band selection over empty timeline space. Returns the current marquee
 * rectangle (for rendering) and a `beginMarquee` handler to start a drag.
 */
export function useMarquee(
  contentRef: RefObject<HTMLDivElement | null>,
  videoRef: RefObject<HTMLDivElement | null>,
  audioRef: RefObject<HTMLDivElement | null>,
) {
  const [rect, setRect] = useState<MarqueeRect | null>(null)
  const baseRef = useRef<Set<string>>(new Set())

  const clipsInRect = (l: number, t: number, r: number, b: number): Set<string> => {
    const { videoClips, audioClips, pxPerSec } = useEditorStore.getState()
    const t1 = l / pxPerSec
    const t2 = r / pxPerSec
    const hit = new Set<string>()
    const bands: { clips: Clip[]; top: number; bot: number }[] = []
    if (videoRef.current) {
      bands.push({ clips: videoClips, top: videoRef.current.offsetTop, bot: videoRef.current.offsetTop + videoRef.current.offsetHeight })
    }
    if (audioRef.current) {
      bands.push({ clips: audioClips, top: audioRef.current.offsetTop, bot: audioRef.current.offsetTop + audioRef.current.offsetHeight })
    }
    for (const band of bands) {
      if (b < band.top || t > band.bot) continue // no vertical overlap
      for (const c of band.clips) {
        if (c.start < t2 && c.start + c.dur > t1) hit.add(c.id) // horizontal overlap
      }
    }
    return hit
  }

  const beginMarquee = (e: React.PointerEvent) => {
    const store = useEditorStore.getState()
    if (store.tool !== 'select' || e.button !== 0) return
    const content = contentRef.current
    if (!content) return

    const contentRect = content.getBoundingClientRect()
    const x0 = e.clientX - contentRect.left
    const y0 = e.clientY - contentRect.top
    const additive = e.shiftKey
    baseRef.current = additive ? new Set(store.selection) : new Set()
    let moved = false

    const onMove = (ev: PointerEvent) => {
      const x1 = ev.clientX - contentRect.left
      const y1 = ev.clientY - contentRect.top
      if (Math.abs(x1 - x0) > 2 || Math.abs(y1 - y0) > 2) moved = true
      const L = Math.min(x0, x1)
      const T = Math.min(y0, y1)
      const W = Math.abs(x1 - x0)
      const H = Math.abs(y1 - y0)
      setRect({ left: L, top: T, width: W, height: H })
      const store = useEditorStore.getState()
      const raw = new Set([...baseRef.current, ...clipsInRect(L, T, L + W, T + H)])
      // Expand to full link groups so marqueeing just the video half of a pair
      // still brings its linked audio half along.
      store.setSelection(expandToLinkGroups([...store.videoClips, ...store.audioClips], raw))
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setRect(null)
      if (!moved && !additive) useEditorStore.getState().clearSelection() // bare click clears
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    e.preventDefault()
  }

  return { marqueeRect: rect, beginMarquee }
}
