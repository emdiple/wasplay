import { useEditorStore } from '../store/editorStore'
import { byStart } from '../lib/timeline'
import { Clip } from './Clip'
import type { TimelineTrack } from '../types'

interface TrackProps {
  track: TimelineTrack
  onEmptyPointerDown: (e: React.PointerEvent) => void
  onDrop: (e: React.DragEvent, track: TimelineTrack) => void
}

/** One timeline layer row holding the clips assigned to it. The data attributes
 *  let the marquee and vertical clip-drag map pointer positions back to lanes. */
export function Track({ track, onEmptyPointerDown, onDrop }: TrackProps) {
  const clips = useEditorStore((s) => (track.kind === 'video' ? s.videoClips : s.audioClips))
  const cutMode = useEditorStore((s) => s.tool === 'cut')
  const laneClips = clips.filter((c) => c.trackId === track.id)

  return (
    <div
      className={`track ${track.kind}` + (cutMode ? ' cut-mode' : '')}
      data-track-id={track.id}
      data-kind={track.kind}
      // Start a marquee only when pressing empty space (clips stop propagation).
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onEmptyPointerDown(e)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => onDrop(e, track)}
    >
      {byStart(laneClips).map((clip) => (
        <Clip key={clip.id} clip={clip} isVideo={track.kind === 'video'} />
      ))}
    </div>
  )
}
