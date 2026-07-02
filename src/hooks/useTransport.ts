import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useEditorStore } from '../store/editorStore'
import { timelineEnd } from '../lib/timeline'

export interface TransportControls {
  playing: boolean
  play: () => void
  pause: () => void
  toggle: () => void
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

  // Stop the RAF loop if the component unmounts mid-playback.
  useEffect(() => () => void (rafRef.current !== null && cancelAnimationFrame(rafRef.current)), [])

  return useMemo(() => ({ playing, play, pause, toggle }), [playing, play, pause, toggle])
}
