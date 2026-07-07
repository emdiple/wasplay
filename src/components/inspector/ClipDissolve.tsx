import { useEffect, useState } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { MAX_DISSOLVE_S, precedingClip } from '../../lib/transition'
import type { Clip } from '../../types'

/** True when the Inspector should offer a dissolve control for `clip` — it either
 *  already has one, or has an adjacent predecessor to dissolve in from. */
export function useCanDissolve(clip: Clip | undefined): boolean {
  return useEditorStore((s) => {
    if (!clip) return false
    if (clip.transitionIn) return true
    const onVideo = s.videoClips.some((c) => c.id === clip.id)
    return !!precedingClip(onVideo ? s.videoClips : s.audioClips, clip)
  })
}

/**
 * Per-group cross-dissolve control for the Inspector. Adds / removes / retunes the
 * dissolve that crosses the *previous* clip into this one. Rendered inside an
 * Inspector group (no section chrome of its own). Length changes commit once on
 * release.
 */
export function ClipDissolve({ clip }: { clip: Clip }) {
  const setClipTransition = useEditorStore((s) => s.setClipTransition)
  const removeClipTransition = useEditorStore((s) => s.removeClipTransition)
  const setStatus = useEditorStore((s) => s.setStatus)

  const dur = clip.transitionIn?.dur ?? 0
  const has = !!clip.transitionIn
  // Adding overlaps a clean predecessor, so cap by this clip's length; when one
  // already exists the ripple recomputes from clean positions, so the cap holds.
  const maxD = Math.max(0.1, Math.min(MAX_DISSOLVE_S, clip.dur))

  const [val, setVal] = useState(dur || 1)
  useEffect(() => setVal(dur || 1), [dur, clip.id])

  const commit = (v: number) => {
    if (!setClipTransition(clip.id, Math.max(0.1, Math.min(maxD, v)))) {
      setStatus('Place a clip directly before this one to dissolve into it.')
    }
  }

  return (
    <div className="clip-dissolve">
      {has ? (
        <>
          <div className="cf-field">
            <span className="ci-icon" aria-hidden>
              ⋈
            </span>
            <span className="cf-label">Dissolve</span>
            <input
              type="range"
              className="ci-slider"
              min={0.1}
              max={maxD}
              step={0.05}
              value={val}
              onChange={(e) => setVal(parseFloat(e.target.value))}
              onPointerUp={() => commit(val)}
              aria-label="Dissolve length (seconds)"
            />
            <input
              type="number"
              className="ci-number"
              min={0.1}
              max={maxD}
              step={0.05}
              value={val}
              onChange={(e) => setVal(parseFloat(e.target.value) || 0.1)}
              onBlur={() => commit(val)}
            />
            <span className="ci-unit">s</span>
          </div>
          <button className="btn cd-remove" onClick={() => removeClipTransition(clip.id)}>
            Remove dissolve
          </button>
        </>
      ) : (
        <button className="btn" onClick={() => commit(Math.min(1, maxD))}>
          ⋈ Add dissolve from previous clip
        </button>
      )}
    </div>
  )
}
