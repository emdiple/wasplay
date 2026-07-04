import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { formatTime } from '../../lib/format'
import { cssVar } from '../../lib/themeColors'
import {
  LUFS_TARGETS,
  DEFAULT_TARGET_LUFS,
  GAIN_MIN_DB,
  GAIN_MAX_DB,
  clampGainDb,
  gainToTarget,
  outputLufs,
  dbToLinear,
  hasMeasuredLoudness,
  formatLufs,
  formatGain,
} from '../../lib/loudness'
import type { MediaInfo, Source } from '../../types'

/**
 * The per-source detail sections (codec, loudness, waveform, thumbnails),
 * shared by the desktop Inspector and the mobile Analyzer modal.
 */
export function SourceSections({ src }: { src: Source }) {
  return (
    <>
      {src.info && <CodecBadges info={src.info} />}
      <Loudness src={src} key={src.id} />
      {src.peaks && <Waveform peaks={src.peaks} gainDb={src.gainDb} />}
      {src.thumbs && src.thumbs.length > 0 && <ThumbnailStrip src={src} />}
    </>
  )
}

function CodecBadges({ info }: { info: MediaInfo }) {
  const items: [string, string | null, string][] = [
    ['Container', info.container, 'container'],
    ['Audio', info.audio_codec, 'audio'],
  ]
  if (info.video_codec) items.push(['Video', info.video_codec, 'video'])
  if (info.channels != null) {
    const chLabel = info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : `${info.channels}ch`
    items.push(['Channels', chLabel, ''])
  }
  if (info.sample_rate != null) items.push(['Sample Rate', `${(info.sample_rate / 1000).toFixed(1)} kHz`, ''])
  if (info.bits_per_sample != null) items.push(['Bit Depth', `${info.bits_per_sample}-bit`, ''])

  return (
    <div className="panel">
      <div className="panel-label">Codec / Container</div>
      <div className="badges">
        {items.map(([label, val, cls]) => (
          <div className="badge-item" key={label}>
            <span className="label">{label}</span>
            <span className={'val ' + cls}>{val ?? '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Loudness + source default-level control. The integrated LUFS is measured once
 * at import and lives on the source (`src.lufs`); this sets a per-source default
 * gain (dB) that newly placed clips inherit, with an "Apply to N clips" action.
 */
function Loudness({ src }: { src: Source }) {
  const updateSource = useEditorStore((s) => s.updateSource)
  const setClipGain = useEditorStore((s) => s.setClipGain)
  const snapshot = useEditorStore((s) => s.snapshot)
  const clipCount = useEditorStore((s) => s.audioClips.reduce((n, c) => (c.sourceId === src.id ? n + 1 : n), 0))
  const [target, setTarget] = useState(DEFAULT_TARGET_LUFS)

  const lufs = src.lufs
  const measured = hasMeasuredLoudness(lufs)
  const gainDb = src.gainDb
  const setGain = (db: number) => updateSource(src.id, { gainDb: clampGainDb(Math.round(db * 10) / 10) })

  // Auto-apply the source level to its timeline clips 0.3s after the last change
  // — no "Apply" button. Skips the initial render (and source switches, since
  // this panel is keyed by src.id) so it only fires on edits.
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const t = setTimeout(() => {
      const ids = useEditorStore
        .getState()
        .audioClips.filter((c) => c.sourceId === src.id)
        .map((c) => c.id)
      if (!ids.length) return
      snapshot()
      setClipGain(ids, gainDb)
    }, 300)
    return () => clearTimeout(t)
  }, [gainDb, src.id, snapshot, setClipGain])

  const lufsText = lufs === undefined ? '…' : formatLufs(lufs)
  const outText = measured ? formatLufs(outputLufs(lufs, gainDb)) : '—'

  return (
    <div className="panel">
      <div className="panel-label">Loudness (EBU R128)</div>
      <div className="metrics">
        <div className="metric">
          <div className="label">Integrated</div>
          <div className={'value' + (measured && lufs > -9 ? ' warn' : '')}>{lufsText}</div>
        </div>
        <div className="metric">
          <div className="label">Default Gain</div>
          <div className={'value ' + (gainDb > 0 ? 'boost' : gainDb < 0 ? 'ok' : '')}>{formatGain(gainDb)}</div>
        </div>
        <div className="metric">
          <div className="label">Est. Output</div>
          <div className="value">{outText}</div>
        </div>
      </div>

      <div className="gain-control">
        <input
          type="range"
          className="gain-slider"
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          step={0.1}
          value={gainDb}
          disabled={!src.hasAudio}
          onChange={(e) => setGain(parseFloat(e.target.value))}
          aria-label="Output gain (dB)"
        />
        <input
          type="number"
          className="gain-number"
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          step={0.1}
          value={gainDb}
          disabled={!src.hasAudio}
          onChange={(e) => setGain(parseFloat(e.target.value) || 0)}
        />
        <span className="gain-unit">dB</span>
      </div>

      <div className="gain-actions">
        <label className="gain-target">
          Normalize to
          <select value={target} onChange={(e) => setTarget(parseFloat(e.target.value))}>
            {LUFS_TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          disabled={!measured}
          title={measured ? `Set gain to reach ${target} LUFS` : 'No loudness measurement yet'}
          onClick={() => setGain(gainToTarget(lufs as number, target))}
        >
          ⟳ Normalize
        </button>
        <button className="btn" disabled={gainDb === 0} onClick={() => setGain(0)}>
          Reset
        </button>
      </div>

      <div className="gain-note">
        <span>
          This is the level for this source. {clipCount > 0 ? (
            <>Changes apply automatically to its {clipCount} timeline clip{clipCount === 1 ? '' : 's'} shortly after you
            adjust.</>
          ) : (
            <>Clips placed from it inherit this level, and each stays independently adjustable on the timeline.</>
          )}
        </span>
      </div>
    </div>
  )
}

function Waveform({ peaks, gainDb }: { peaks: Float32Array; gainDb: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useEditorStore((s) => s.theme)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const H = Math.round(100 * dpr)
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    const mid = H / 2
    ctx.fillStyle = cssVar('--canvas-bg')
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = cssVar('--wave-baseline')
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(W, mid)
    ctx.stroke()

    const edge = cssVar('--wave-edge')
    const midColor = cssVar('--wave-mid')
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, edge)
    grad.addColorStop(0.45, midColor)
    grad.addColorStop(0.5, midColor)
    grad.addColorStop(1, edge)
    ctx.fillStyle = grad
    // Scale the drawn amplitude by the source's output gain, so the shape tracks
    // the level (clamped to the panel so a boost can't overflow).
    const scale = dbToLinear(gainDb)
    for (let x = 0; x < W; x++) {
      const idx = Math.min(peaks.length - 1, Math.floor((x / W) * peaks.length))
      const h = Math.max(1, Math.min(mid, peaks[idx] * scale * mid))
      ctx.fillRect(x, mid - h, 1, h * 2)
    }
  }, [peaks, gainDb, theme])

  return (
    <div className="panel">
      <div className="panel-label">Waveform</div>
      <canvas className="analyzer-wave" ref={canvasRef} />
    </div>
  )
}

function ThumbnailStrip({ src }: { src: Source }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useEditorStore((s) => s.theme)

  useEffect(() => {
    const canvas = canvasRef.current
    const thumbs = src.thumbs
    if (!canvas || !thumbs || !thumbs.length) return
    const dpr = window.devicePixelRatio || 1
    const stripCssW = canvas.clientWidth || 680
    const count = thumbs.length
    const thumbCssW = Math.floor(stripCssW / count)
    const thumbCssH = Math.round(thumbCssW * ((src.height || 9) / (src.width || 16)))

    const W = Math.round(stripCssW * dpr)
    const H = Math.round(thumbCssH * dpr)
    const tw = Math.round(thumbCssW * dpr)
    canvas.width = W
    canvas.height = H
    canvas.style.height = thumbCssH + 'px'

    const bg = cssVar('--canvas-bg')
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)
    thumbs.forEach(({ bitmap, timestamp_s }, i) => {
      const x = i * tw
      try {
        ctx.drawImage(bitmap, x, 0, tw, H) // shared with the timeline — do not close
      } catch {
        /* bitmap gone */
      }
      if (i > 0) {
        ctx.fillStyle = bg
        ctx.fillRect(x, 0, 1, H)
      }
      const label = formatTime(timestamp_s)
      const pad = Math.round(3 * dpr)
      const fsize = Math.round(9 * dpr)
      ctx.font = `${fsize}px "SF Mono", "Fira Code", monospace`
      const labelW = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(x + pad, H - fsize - pad * 2, labelW + pad * 2, fsize + pad * 2)
      ctx.fillStyle = '#e8eaf0'
      ctx.fillText(label, x + pad * 2, H - pad * 2)
    })
  }, [src, theme])

  return (
    <div className="panel">
      <div className="panel-label">Timeline Thumbnails</div>
      <canvas className="analyzer-thumbs" ref={canvasRef} />
    </div>
  )
}
