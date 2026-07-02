import { useEditorStore } from '../store/editorStore'

/** The red playhead line spanning the ruler and both tracks. */
export function Playhead() {
  const left = useEditorStore((s) => s.playheadTime * s.pxPerSec)
  return <div className="playhead" style={{ left }} />
}
