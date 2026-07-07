import { useEditorStore } from '../../store/editorStore'
import {
  LUFS_TARGETS,
  TARGET_MIN_LUFS,
  TARGET_MAX_LUFS,
  GAIN_MIN_DB,
  GAIN_MAX_DB,
  clampGainDb,
  gainToTarget,
  formatLufs,
  formatGain,
  hasMeasuredLoudness,
} from '../../lib/loudness'
import type { Clip, Source } from '../../types'

/**
 * Per-clip audio level control shared by the timeline strip (mobile) and the
 * right Inspector (desktop). Level is a property of each clip, so split parts of
 * one source can sit at different levels; Normalize sets each selected clip's
 * gain from its own source's measured loudness. `variant` only changes layout.
 */
export function AudioLevel({ clips, variant }: { clips: Clip[]; variant: 'strip' | 'stack' }) {
  const sources = useEditorStore((s) => s.sources)
  const setClipGain = useEditorStore((s) => s.setClipGain)
  const snapshot = useEditorStore((s) => s.snapshot)
  // The normalize target is a shared, persisted app default — not local state.
  const target = useEditorStore((s) => s.audioTargetLufs)
  const setTarget = useEditorStore((s) => s.setAudioTargetLufs)

  if (!clips.length) return null

  const ids = clips.map((c) => c.id)
  const byId = new Map(sources.map((s) => [s.id, s]))

  // Uniform gain across the selection, or null when they differ ("mixed").
  const first = clips[0].gainDb
  const uniform = clips.every((c) => c.gainDb === first) ? first : null

  const srcIds = new Set(clips.map((c) => c.sourceId))
  const soleSource: Source | undefined = srcIds.size === 1 ? byId.get(clips[0].sourceId) : undefined

  const apply = (db: number) => setClipGain(ids, clampGainDb(Math.round(db * 10) / 10))

  const normalize = () => {
    snapshot()
    for (const srcId of srcIds) {
      const src = byId.get(srcId)
      if (!src || !hasMeasuredLoudness(src.lufs)) continue
      const clipIds = clips.filter((c) => c.sourceId === srcId).map((c) => c.id)
      setClipGain(clipIds, gainToTarget(src.lufs, target))
    }
  }

  const canNormalize = [...srcIds].some((id) => hasMeasuredLoudness(byId.get(id)?.lufs))
  const label =
    clips.length === 1
      ? `${soleSource?.name ?? 'clip'}`
      : srcIds.size === 1
        ? `${clips.length} clips · ${soleSource?.name ?? ''}`
        : `${clips.length} audio clips`

  return (
    <div className={'audio-level ' + variant}>
      <div className="al-head">
        <span className="ci-icon" aria-hidden>
          🔊
        </span>
        <span className="ci-label" title={label}>
          {label}
        </span>
        {soleSource && <span className="ci-lufs">{formatLufs(soleSource.lufs)}</span>}
        {uniform !== null && uniform !== 0 && <span className="ci-badge">{formatGain(uniform)}</span>}
      </div>

      <div className="al-slider-row">
        <input
          type="range"
          className="ci-slider"
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          step={0.1}
          value={uniform ?? 0}
          onPointerDown={snapshot}
          onChange={(e) => apply(parseFloat(e.target.value))}
          aria-label="Clip output gain (dB)"
        />
        <input
          type="number"
          className="ci-number"
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          step={0.1}
          value={uniform ?? ''}
          placeholder="mixed"
          onFocus={snapshot}
          onChange={(e) => apply(parseFloat(e.target.value) || 0)}
        />
        <span className="ci-unit">dB</span>
      </div>

      <div className="al-actions">
        <label className="al-target" title="Loudness target that Normalize aims for">
          <span className="al-target-cap">Target</span>
          <input
            type="number"
            className="ci-number al-target-num"
            min={TARGET_MIN_LUFS}
            max={TARGET_MAX_LUFS}
            step={0.5}
            value={target}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (Number.isFinite(v)) setTarget(Math.min(TARGET_MAX_LUFS, Math.max(TARGET_MIN_LUFS, v)))
            }}
            aria-label="Normalize target (LUFS)"
          />
          <span className="ci-unit">LUFS</span>
          <select
            className="al-target-preset"
            value={LUFS_TARGETS.some((t) => t.value === target) ? String(target) : ''}
            onChange={(e) => e.target.value && setTarget(parseFloat(e.target.value))}
            aria-label="Loudness preset"
          >
            <option value="">Presets…</option>
            {LUFS_TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <div className="al-buttons">
          <button
            className="btn primary"
            disabled={!canNormalize}
            onClick={normalize}
            title={canNormalize ? `Set each selected clip's gain to reach ${target} LUFS` : 'No loudness measurement yet'}
          >
            ⟳ Normalize
          </button>
          <button
            className="btn"
            disabled={uniform === 0}
            onClick={() => {
              snapshot()
              apply(0)
            }}
            title="Reset gain to 0 dB"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}
