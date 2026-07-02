import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { getObjectUrl } from '../lib/objectUrlCache'
import type { Clip, Source } from '../types'

/** How far a media element's `currentTime` may drift from the playhead during
 * playback before it gets hard-corrected. Native playback runs its own clock,
 * so correcting every frame would cause constant micro-seeks and stutter —
 * this only steps in once drift is actually noticeable. */
const DRIFT_TOLERANCE_S = 0.25

/**
 * Keeps a `<video>`/`<audio>` element in sync with the app's virtual timeline
 * clock (`playheadTime`): swaps `src` when the active clip's source changes,
 * hard-seeks while paused/scrubbing, and soft-corrects drift during playback.
 *
 * Pass `activeClip: null` to mean "nothing should play on this element right
 * now" (e.g. the audio track's clip is already sounding through a linked
 * video element, so this element should stay silent rather than double it up).
 *
 * `muted` is applied imperatively rather than via a JSX `muted` attribute,
 * which React sets unreliably on media elements.
 */
export function usePreviewTrack(
  mediaRef: RefObject<HTMLMediaElement | null>,
  activeClip: Clip | null,
  source: Source | undefined,
  playing: boolean,
  localTime: number,
  muted: boolean,
) {
  const lastSourceId = useRef<string | null>(null)

  // Apply mute state directly on the element (JSX `muted` is unreliable).
  useEffect(() => {
    const media = mediaRef.current
    if (media) media.muted = muted
  }, [muted, mediaRef])

  // Swap source when the active clip's underlying file changes.
  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    if (!activeClip || !source) {
      if (lastSourceId.current !== null) {
        media.removeAttribute('src')
        media.load()
        lastSourceId.current = null
      }
      return
    }
    if (lastSourceId.current !== source.id) {
      media.src = getObjectUrl(source.id, source.file)
      media.currentTime = localTime
      media.muted = muted // ensure the freshly-set src honours the current mute state
      lastSourceId.current = source.id
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.id, source?.id, mediaRef])

  // Play/pause to match the transport state.
  useEffect(() => {
    const media = mediaRef.current
    if (!media || !activeClip) return
    if (playing) media.play().catch(() => {})
    else media.pause()
  }, [playing, activeClip?.id, mediaRef])

  // Hard-seek when paused/scrubbing; soft drift-correction while playing.
  useEffect(() => {
    const media = mediaRef.current
    if (!media || !activeClip) return
    const drift = Math.abs(media.currentTime - localTime)
    if (!playing ? drift > 0.01 : drift > DRIFT_TOLERANCE_S) {
      media.currentTime = localTime
    }
  }, [localTime, playing, activeClip?.id, mediaRef])
}
