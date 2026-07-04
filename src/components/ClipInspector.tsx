import { useEditorStore } from '../store/editorStore'
import { AudioLevel } from './inspector/AudioLevel'
import type { Clip } from '../types'

/**
 * Timeline selection strip (mobile only — desktop uses the right Inspector).
 * Shows the shared per-clip audio level control when audio clips are selected.
 */
export function ClipInspector() {
  const selection = useEditorStore((s) => s.selection)
  const audioClips = useEditorStore((s) => s.audioClips)
  const selected = audioClips.filter((c) => selection.has(c.id))
  if (!selected.length) return null
  return <AudioLevel clips={selected} variant="strip" />
}

/** True when at least one selected clip is an audio clip (drives the strip's visibility). */
export function hasAudioSelection(selection: Set<string>, audioClips: Clip[]): boolean {
  return audioClips.some((c) => selection.has(c.id))
}
