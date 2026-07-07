import { useEditorStore } from '../store/editorStore'
import { AudioLevel } from './inspector/AudioLevel'
import { ClipFades } from './inspector/ClipFades'
import type { Clip } from '../types'

/**
 * Timeline selection strip (mobile only — desktop uses the right Inspector).
 * Shows the per-clip fade control for any selection, plus the audio level
 * control when audio clips are selected.
 */
export function ClipInspector() {
  const selection = useEditorStore((s) => s.selection)
  const videoClips = useEditorStore((s) => s.videoClips)
  const audioClips = useEditorStore((s) => s.audioClips)
  const selected = [...videoClips, ...audioClips].filter((c) => selection.has(c.id))
  const selectedAudio = audioClips.filter((c) => selection.has(c.id))
  if (!selected.length) return null
  return (
    <>
      <ClipFades clips={selected} variant="strip" />
      {selectedAudio.length > 0 && <AudioLevel clips={selectedAudio} variant="strip" />}
    </>
  )
}

/** True when at least one clip (either track) is selected — drives the strip's visibility. */
export function hasClipSelection(selection: Set<string>, videoClips: Clip[], audioClips: Clip[]): boolean {
  return [...videoClips, ...audioClips].some((c) => selection.has(c.id))
}
