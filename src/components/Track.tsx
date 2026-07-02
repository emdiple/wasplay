import type { RefObject } from 'react'
import { useEditorStore } from '../store/editorStore'
import { byStart } from '../lib/timeline'
import { Clip } from './Clip'
import type { TrackKind } from '../types'

interface TrackProps {
  kind: TrackKind
  trackRef: RefObject<HTMLDivElement | null>
  onEmptyPointerDown: (e: React.PointerEvent) => void
  onDrop: (e: React.DragEvent) => void
}

/** One timeline track (video or audio) holding its clips. */
export function Track({ kind, trackRef, onEmptyPointerDown, onDrop }: TrackProps) {
  const clips = useEditorStore((s) => (kind === 'video' ? s.videoClips : s.audioClips))
  const cutMode = useEditorStore((s) => s.tool === 'cut')

  return (
    <div
      ref={trackRef}
      className={`track ${kind}` + (cutMode ? ' cut-mode' : '')}
      // Start a marquee only when pressing empty space (clips stop propagation).
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onEmptyPointerDown(e)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    >
      {byStart(clips).map((clip) => (
        <Clip key={clip.id} clip={clip} isVideo={kind === 'video'} />
      ))}
    </div>
  )
}
