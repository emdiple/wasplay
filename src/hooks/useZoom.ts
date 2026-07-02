import { useCallback, useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { useEditorStore } from '../store/editorStore'
import { domainSeconds } from '../lib/timeline'

export interface ZoomControls {
  zoomIn: () => void
  zoomOut: () => void
  setZoom: (next: number) => void
  fitTimeline: () => void
}

/**
 * Zoom is bounded below by "fit": the whole (possibly expanded) domain filling
 * the viewport. Zooming out can't shrink it further; zooming in expands it and
 * the timeline scrolls horizontally.
 */
export function useZoom(scrollRef: RefObject<HTMLDivElement | null>): ZoomControls {
  const setPxPerSec = useEditorStore((s) => s.setPxPerSec)

  const fitPxPerSec = useCallback(() => {
    const { videoClips, audioClips } = useEditorStore.getState()
    const w = scrollRef.current?.clientWidth || 800
    return Math.max(0.02, w / domainSeconds(videoClips, audioClips))
  }, [scrollRef])

  const setZoom = useCallback(
    (next: number) => {
      setPxPerSec(Math.max(fitPxPerSec(), Math.min(400, next)))
    },
    [fitPxPerSec, setPxPerSec],
  )

  const fitTimeline = useCallback(() => setZoom(fitPxPerSec()), [setZoom, fitPxPerSec])
  const zoomIn = useCallback(() => setZoom(useEditorStore.getState().pxPerSec * 1.35), [setZoom])
  const zoomOut = useCallback(() => setZoom(useEditorStore.getState().pxPerSec / 1.35), [setZoom])

  // Re-apply the fit clamp on resize (viewport width changes the minimum zoom).
  useEffect(() => {
    const onResize = () => setZoom(useEditorStore.getState().pxPerSec)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setZoom])

  return useMemo(() => ({ zoomIn, zoomOut, setZoom, fitTimeline }), [zoomIn, zoomOut, setZoom, fitTimeline])
}
