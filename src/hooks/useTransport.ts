import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useEditorStore } from '../store/editorStore'
import { timelineEnd } from '../lib/timeline'
import { EXPORT_FPS } from '../export/project'

export interface TransportControls {
  playing: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  /** Move the playhead to an absolute time (clamped to the timeline), pausing playback. */
  seek: (t: number) => void
  /** Step one frame forward (dir=1) or back (dir=-1) at the project frame rate. */
  stepFrame: (dir: 1 | -1) => void
  goToStart: () => void
  goToEnd: () => void
  /** Project frame rate used for frame-accurate stepping. */
  fps: number
}

/**
 * Playhead transport. Advances the playhead in real time via requestAnimationFrame
 * and keeps it scrolled into view. Playback stops at the end of the last clip.
 */
export function useTransport(scrollRef: RefObject<HTMLDivElement | null>): TransportControls {
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)
  const lastRef = useRef(0)

  const autoScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { playheadTime, pxPerSec } = useEditorStore.getState()
    const x = playheadTime * pxPerSec
    const left = el.scrollLeft
    const right = left + el.clientWidth
    if (x < left + 40) el.scrollLeft = Math.max(0, x - 40)
    else if (x > right - 60) el.scrollLeft = x - el.clientWidth + 60
  }, [scrollRef])

  const pause = useCallback(() => {
    setPlaying(false)
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  const play = useCallback(() => {
    if (rafRef.current !== null) return
    const store = useEditorStore.getState()
    if (store.playheadTime >= timelineEnd(store.videoClips, store.audioClips)) store.setPlayhead(0)
    setPlaying(true)
    lastRef.current = performance.now()

    const tick = (ts: number) => {
      const s = useEditorStore.getState()
      const dt = (ts - lastRef.current) / 1000
      lastRef.current = ts
      const end = timelineEnd(s.videoClips, s.audioClips)
      const next = s.playheadTime + dt
      if (next >= end) {
        s.setPlayhead(end)
        autoScroll()
        pause()
        return
      }
      s.setPlayhead(next)
      autoScroll()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [autoScroll, pause])

  const toggle = useCallback(() => {
    if (rafRef.current !== null) pause()
    else play()
  }, [play, pause])

  // Move the playhead to an absolute, clamped time. Pauses first so a manual
  // scrub/step never fights the running rAF loop.
  const seek = useCallback(
    (t: number) => {
      pause()
      const s = useEditorStore.getState()
      const end = timelineEnd(s.videoClips, s.audioClips)
      s.setPlayhead(Math.max(0, Math.min(end, t)))
      autoScroll()
    },
    [pause, autoScroll],
  )

  const stepFrame = useCallback(
    (dir: 1 | -1) => {
      // Snap to the frame grid before stepping so repeated steps stay aligned.
      const t = useEditorStore.getState().playheadTime
      const frame = Math.round(t * EXPORT_FPS)
      seek((frame + dir) / EXPORT_FPS)
    },
    [seek],
  )

  const goToStart = useCallback(() => seek(0), [seek])
  const goToEnd = useCallback(() => {
    const s = useEditorStore.getState()
    seek(timelineEnd(s.videoClips, s.audioClips))
  }, [seek])

  // Stop the RAF loop if the component unmounts mid-playback.
  useEffect(() => () => void (rafRef.current !== null && cancelAnimationFrame(rafRef.current)), [])

  return useMemo(
    () => ({ playing, play, pause, toggle, seek, stepFrame, goToStart, goToEnd, fps: EXPORT_FPS }),
    [playing, play, pause, toggle, seek, stepFrame, goToStart, goToEnd],
  )
}
