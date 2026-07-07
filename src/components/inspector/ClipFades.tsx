import { useEditorStore } from '../../store/editorStore'
import { FADE_MAX_S } from '../../lib/fade'
import type { Clip } from '../../types'

/**
 * Per-clip fade-in / fade-out control, shared by the timeline strip (mobile) and
 * the right Inspector (desktop). Fades are a property of each clip and apply to
 * both picture (fade from/to black) and sound (ramp from/to silence), so a
 * selected linked A/V pair fades together. `variant` only changes layout.
 */
export function ClipFades({ clips, variant }: { clips: Clip[]; variant: 'strip' | 'stack' }) {
  const setClipFades = useEditorStore((s) => s.setClipFades)
  const snapshot = useEditorStore((s) => s.snapshot)

  if (!clips.length) return null

  const ids = clips.map((c) => c.id)
  // Fades can't exceed the shortest selected clip (the store re-clamps per clip too).
  const maxFade = Math.min(FADE_MAX_S, ...clips.map((c) => c.dur))

  // A uniform value across the selection, or null when they differ ("mixed").
  const uniform = (pick: (c: Clip) => number): number | null => {
    const first = pick(clips[0])
    return clips.every((c) => pick(c) === first) ? first : null
  }
  const fin = uniform((c) => c.fadeIn ?? 0)
  const fout = uniform((c) => c.fadeOut ?? 0)

  const round = (v: number) => Math.round(v * 100) / 100
  const apply = (key: 'fadeIn' | 'fadeOut', v: number) =>
    setClipFades(ids, { [key]: Math.max(0, Math.min(maxFade, round(v))) })

  return (
    <div className={'clip-fades ' + variant}>
      <FadeField
        label="Fade In"
        icon="◗"
        value={fin}
        max={maxFade}
        onSnapshot={snapshot}
        onChange={(v) => apply('fadeIn', v)}
      />
      <FadeField
        label="Fade Out"
        icon="◖"
        value={fout}
        max={maxFade}
        onSnapshot={snapshot}
        onChange={(v) => apply('fadeOut', v)}
      />
    </div>
  )
}

function FadeField({
  label,
  icon,
  value,
  max,
  onSnapshot,
  onChange,
}: {
  label: string
  icon: string
  value: number | null
  max: number
  onSnapshot: () => void
  onChange: (v: number) => void
}) {
  return (
    <div className="cf-field">
      <span className="ci-icon" aria-hidden>
        {icon}
      </span>
      <span className="cf-label">{label}</span>
      <input
        type="range"
        className="ci-slider"
        min={0}
        max={max}
        step={0.05}
        value={value ?? 0}
        onPointerDown={onSnapshot}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={`${label} (seconds)`}
      />
      <input
        type="number"
        className="ci-number"
        min={0}
        max={max}
        step={0.05}
        value={value ?? ''}
        placeholder="mixed"
        onFocus={onSnapshot}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
      <span className="ci-unit">s</span>
    </div>
  )
}
